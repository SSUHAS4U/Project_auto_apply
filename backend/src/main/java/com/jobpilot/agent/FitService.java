package com.jobpilot.agent;

import com.jobpilot.domain.Profile;
import com.jobpilot.service.KeywordMatchScorer;
import com.jobpilot.service.ProfileService;
import com.jobpilot.service.ai.AiService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The judgement layer between "we scraped something" and "we act on it".
 *
 * Two questions, both of which the automation used to answer by keyword overlap alone — which is
 * how a Python role scored 38 and still got applied to, and how outreach messaged twenty people
 * whose headlines nobody ever read:
 *
 *   1. {@link #jobFit} — should this job be applied to, given the actual résumé?
 *   2. {@link #recruiterFit} — is this person actually a recruiter / hiring for something?
 *
 * Determinism matters more than cleverness here: the same job must produce the same verdict on
 * every run, or the "why did it apply to that?" question is unanswerable. So every verdict is
 * cached on a hash of (what we judged + the profile version), the model is asked for strict JSON
 * at temperature-neutral phrasing, and a deterministic keyword score is always computed as the
 * floor. If the AI is unavailable or returns nonsense, the caller still gets a usable answer with
 * {@code source:"keyword"} and a conservative techMatch, rather than a crash or a free pass.
 */
@Service
public class FitService {

    private static final Logger log = LoggerFactory.getLogger(FitService.class);

    /** Headlines that mean "this person hires". Checked before any model call — cheap and exact. */
    private static final List<String> RECRUITER_TITLES = List.of(
            "recruiter", "recruiting", "recruitment", "talent acquisition", "talent aquisition",
            "talent partner", "talent sourcer", "sourcer", "hiring manager", "hiring lead",
            "human resources", "hr manager", "hr executive", "hr business partner", "hrbp",
            "people operations", "people ops", "staffing", "campus recruitment", "hiring");

    /** Headlines that mean "not a hiring contact", even if the word 'hiring' appears nearby. */
    private static final List<String> REJECT_TITLES = List.of(
            "sales", "marketing", "business development", "bdm", "financial", "accountant",
            "insurance agent", "real estate", "student", "seeking", "looking for a job",
            "open to work", "aspiring", "fresher");

    private final AiService ai;
    private final ProfileService profiles;
    private final KeywordMatchScorer scorer;
    private final ObjectMapper json = new ObjectMapper();

    /** verdict cache — same input + same profile version ⇒ same answer, no repeat model spend. */
    private final Map<String, Map<String, Object>> cache = new ConcurrentHashMap<>();

    public FitService(AiService ai, ProfileService profiles, KeywordMatchScorer scorer) {
        this.ai = ai;
        this.profiles = profiles;
        this.scorer = scorer;
    }

    // ---- 1. job ↔ résumé compatibility ---------------------------------------

    private static final String FIT_SYSTEM = """
        You are a strict technical recruiter screening ONE job for ONE candidate.

        Score the job against the candidate using exactly these weights (total 100):
          required skills 35 · preferred skills 15 · experience level 15 · role similarity 15
          · industry/domain 5 · location 5 · education 5 · projects/keywords 5

        Rules you must follow:
        - Judge the CANDIDATE'S ACTUAL SKILLS. If the job's core language or stack is absent from
          the candidate's skills and projects, techMatch is false and the score cannot exceed 55,
          no matter how well the title matches.
        - A shared job title with a different stack is NOT a match. "Software Engineer" requiring
          Python does not match a Java/MERN candidate.
        - Seniority mismatch (job wants more years than the candidate has, or is a lead/principal
          /manager role) caps the score at 50.
        - Do not reward vague, buzzword-only descriptions. If the description is too thin to judge,
          set confidence low and score conservatively.

        Reply with ONLY this JSON object and nothing else:
        {"score": <0-100 integer>, "techMatch": <true|false>, "confidence": <0-100 integer>,
         "matched": ["skill", ...], "missing": ["skill", ...], "reason": "<one short sentence>"}
        """;

    /**
     * Should we apply to this job? Returns score / techMatch / reason, always populated.
     * Never throws — a failure downgrades to the keyword score rather than blocking the run.
     */
    public Map<String, Object> jobFit(String title, String company, String location, String description) {
        String candidate = candidateSummary();
        String jobText = ("" + nz(title) + "\n" + nz(company) + "\n" + nz(location) + "\n" + nz(description)).trim();
        String key = "job:" + Objects.hash(candidate, jobText.toLowerCase());
        Map<String, Object> hit = cache.get(key);
        if (hit != null) return hit;

        int keywordScore = keywordScore(title, company, location, description);
        Map<String, Object> out = aiJobFit(candidate, title, company, location, description, keywordScore);
        cache.put(key, out);
        return out;
    }

    /** Sentinel prefix used by {@link #candidateSummary()} when there is nothing to compare against. */
    static final String NO_CANDIDATE = "(profile";

    private Map<String, Object> aiJobFit(String candidate, String title, String company,
                                         String location, String description, int keywordScore) {
        // No candidate = no verdict. Without this the placeholder string "(profile is empty …)"
        // was sent to the model AS the candidate; it then quite correctly scored every job 0
        // with techMatch=false, and because the result was tagged source="ai" the worker
        // reported each one as "stack mismatch (fit 0)". A whole run would skip every job for a
        // reason that had nothing to do with the jobs, and nothing anywhere named the profile.
        // Fail closed, and say exactly what to fix.
        if (candidate == null || candidate.startsWith(NO_CANDIDATE)) {
            return verdict(0, false, 0, List.of(), List.of(),
                    "your JobPilot profile has no skills or experience saved, so no job can be "
                    + "judged against it — fill in Profile, then run again",
                    "no_profile");
        }
        // Too little text to judge honestly — say so rather than inventing a verdict.
        String desc = nz(description);
        if (desc.length() < 80 || !ai.isEnabled()) {
            return verdict(keywordScore, keywordScore >= 60, keywordScore, List.of(), List.of(),
                    desc.length() < 80 ? "description too short to judge" : "AI disabled — keyword score only",
                    "keyword");
        }
        String user = "CANDIDATE\n" + candidate
                + "\n\nJOB\nTitle: " + nz(title)
                + "\nCompany: " + nz(company)
                + "\nLocation: " + nz(location)
                + "\nDescription:\n" + desc.substring(0, Math.min(desc.length(), 4000));
        try {
            JsonNode n = parseJson(ai.complete(FIT_SYSTEM, user, false, true));
            if (n == null) return verdict(keywordScore, keywordScore >= 60, 40, List.of(), List.of(),
                    "AI reply unreadable — keyword score only", "keyword");
            int score = clamp(n.path("score").asInt(keywordScore));
            boolean tech = n.path("techMatch").asBoolean(false);
            int conf = clamp(n.path("confidence").asInt(60));
            // Enforce the cap the prompt asks for, in code — a model that ignores its own rule
            // must not be able to wave a stack-mismatch through.
            if (!tech) score = Math.min(score, 55);
            return verdict(score, tech, conf, strings(n.path("matched")), strings(n.path("missing")),
                    n.path("reason").asText(""), "ai");
        } catch (Exception e) {
            log.debug("jobFit AI failed: {}", e.getMessage());
            return verdict(keywordScore, keywordScore >= 60, 40, List.of(), List.of(),
                    "AI unavailable — keyword score only", "keyword");
        }
    }

    private Map<String, Object> verdict(int score, boolean tech, int confidence,
                                        List<String> matched, List<String> missing,
                                        String reason, String source) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("score", clamp(score));
        m.put("techMatch", tech);
        m.put("confidence", clamp(confidence));
        m.put("matched", matched);
        m.put("missing", missing);
        m.put("reason", reason == null ? "" : reason);
        m.put("source", source);
        return m;
    }

    // ---- 2. is this person worth contacting? ---------------------------------

    private static final String POST_SYSTEM = """
        You decide whether a LinkedIn person is worth contacting about a job.
        Given their headline and their recent posts, answer whether they RECRUIT or are HIRING.
        A person counts if their role is recruiting/talent/HR/hiring, OR a recent post announces
        an opening, a referral offer, or team growth. Someone merely discussing the industry, or
        looking for a job themselves, does NOT count.

        Reply with ONLY this JSON and nothing else:
        {"isRecruiter": <true|false>, "hiringNow": <true|false>, "confidence": <0-100 integer>,
         "topic": "<the specific thing they posted about, or empty>", "reason": "<short>"}
        """;

    /**
     * Should we contact this person at all? The headline decides it outright when it can (fast,
     * exact, free); the model is only consulted for the ambiguous middle, and only when we have
     * post text worth reading.
     */
    public Map<String, Object> recruiterFit(String name, String headline, List<String> recentPosts) {
        String h = nz(headline).toLowerCase();
        String posts = recentPosts == null ? "" : String.join("\n---\n", recentPosts);
        String key = "person:" + Objects.hash(h, posts.toLowerCase());
        Map<String, Object> hit = cache.get(key);
        if (hit != null) return hit;

        Map<String, Object> out;
        boolean rejected = REJECT_TITLES.stream().anyMatch(h::contains);
        boolean titleOk = RECRUITER_TITLES.stream().anyMatch(h::contains);

        if (titleOk && !rejected) {
            out = person(true, false, 95, "", "headline says " + matchedTitle(h), "title");
        } else if (rejected && !titleOk) {
            out = person(false, false, 90, "", "headline is not a hiring role", "title");
        } else if (posts.isBlank() || !ai.isEnabled()) {
            // No headline signal and nothing to read → do NOT contact. Silence is the safe answer;
            // messaging on no evidence is exactly the behaviour being fixed.
            out = person(false, false, 55, "",
                    posts.isBlank() ? "no recruiter title and no posts to judge" : "AI disabled", "title");
        } else {
            out = aiPerson(name, headline, posts);
        }
        cache.put(key, out);
        return out;
    }

    private Map<String, Object> aiPerson(String name, String headline, String posts) {
        String user = "NAME: " + nz(name) + "\nHEADLINE: " + nz(headline)
                + "\n\nRECENT POSTS:\n" + posts.substring(0, Math.min(posts.length(), 3000));
        try {
            JsonNode n = parseJson(ai.complete(POST_SYSTEM, user, true, true));
            if (n == null) return person(false, false, 40, "", "AI reply unreadable", "ai");
            return person(n.path("isRecruiter").asBoolean(false), n.path("hiringNow").asBoolean(false),
                    clamp(n.path("confidence").asInt(60)), n.path("topic").asText(""),
                    n.path("reason").asText(""), "ai");
        } catch (Exception e) {
            log.debug("recruiterFit AI failed: {}", e.getMessage());
            return person(false, false, 40, "", "AI unavailable", "ai");
        }
    }

    // ---- 3. is this POST a real opening? -------------------------------------

    private static final String POST_INTENT_SYSTEM = """
        You classify a single LinkedIn post. Decide whether it announces a JOB OPENING the
        reader could apply or refer themselves to — a specific role being hired, a referral
        offer, or a team actively growing.

        Does NOT count: someone announcing they got a job, someone looking for work, congratulation
        posts, general industry commentary, course/bootcamp promotion, or hiring news about a
        company the author doesn't work at.

        Reply with ONLY this JSON and nothing else:
        {"isHiring": <true|false>, "confidence": <0-100 integer>,
         "role": "<the role being hired, or empty>", "topic": "<short phrase naming the opening>"}
        """;

    /**
     * Read one hiring post. Post scanning used to be a bare email regex, so 150 posts yielded
     * nothing at all — most recruiters never put an address in the text. Classifying intent
     * turns the same scan into a list of people worth contacting, with the post as the opener.
     */
    public Map<String, Object> postIntent(String postText) {
        String text = nz(postText).trim();
        Map<String, Object> no = post(false, 0, "", "", "short");
        if (text.length() < 60) return no;

        String key = "post:" + Objects.hash(text.toLowerCase());
        Map<String, Object> hit = cache.get(key);
        if (hit != null) return hit;
        if (!ai.isEnabled()) return no;

        Map<String, Object> out;
        try {
            JsonNode n = parseJson(ai.complete(POST_INTENT_SYSTEM,
                    text.substring(0, Math.min(text.length(), 2500)), true, true));
            out = n == null ? post(false, 0, "", "", "unreadable")
                    : post(n.path("isHiring").asBoolean(false), clamp(n.path("confidence").asInt(0)),
                           n.path("role").asText(""), n.path("topic").asText(""), "ai");
        } catch (Exception e) {
            log.debug("postIntent AI failed: {}", e.getMessage());
            out = post(false, 0, "", "", "unavailable");
        }
        cache.put(key, out);
        return out;
    }

    private Map<String, Object> post(boolean isHiring, int confidence, String role, String topic, String source) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("isHiring", isHiring);
        m.put("confidence", confidence);
        m.put("role", role == null ? "" : role);
        m.put("topic", topic == null ? "" : topic);
        m.put("source", source);
        return m;
    }

    private Map<String, Object> person(boolean isRecruiter, boolean hiringNow, int confidence,
                                       String topic, String reason, String source) {
        Map<String, Object> m = new LinkedHashMap<>();
        // "Contact them" is the only field the worker needs to branch on.
        m.put("contact", isRecruiter || hiringNow);
        m.put("isRecruiter", isRecruiter);
        m.put("hiringNow", hiringNow);
        m.put("confidence", clamp(confidence));
        m.put("topic", topic == null ? "" : topic);
        m.put("reason", reason == null ? "" : reason);
        m.put("source", source);
        return m;
    }

    private static String matchedTitle(String h) {
        return RECRUITER_TITLES.stream().filter(h::contains).findFirst().orElse("a hiring role");
    }

    // ---- helpers -------------------------------------------------------------

    /** The candidate, as the model should see them: skills and evidence, not marketing copy. */
    String candidateSummary() {
        Profile p;
        try { p = profiles.get(); } catch (Exception e) { return "(profile unavailable)"; }
        StringBuilder b = new StringBuilder();
        if (notBlank(p.getHeadline())) b.append("Headline: ").append(p.getHeadline()).append('\n');
        if (notBlank(p.getYearsExperience())) b.append("Years of experience: ").append(p.getYearsExperience()).append('\n');
        if (notBlank(p.getExperienceLevel())) b.append("Level: ").append(p.getExperienceLevel()).append('\n');
        if (p.getSkills() != null && !p.getSkills().isEmpty())
            b.append("Skills: ").append(String.join(", ", p.getSkills())).append('\n');
        if (p.getSkillsExperience() != null && !p.getSkillsExperience().isEmpty())
            b.append("Skill depth: ").append(p.getSkillsExperience()).append('\n');
        if (notBlank(p.getDesiredTitles())) b.append("Target roles: ").append(p.getDesiredTitles()).append('\n');
        if (notBlank(p.getLocation())) b.append("Location: ").append(p.getLocation()).append('\n');
        appendList(b, "Projects", p.getProjects(), 6);
        appendList(b, "Education", p.getEducation(), 3);
        appendList(b, "Certifications", p.getCertifications(), 5);
        if (notBlank(p.getSummary())) b.append("Summary: ").append(trim(p.getSummary(), 500)).append('\n');
        return b.length() == 0 ? "(profile is empty — fill in Profile first)" : b.toString();
    }

    private static void appendList(StringBuilder b, String label, List<Map<String, Object>> items, int max) {
        if (items == null || items.isEmpty()) return;
        b.append(label).append(":\n");
        items.stream().limit(max).forEach(m -> b.append("  - ").append(trim(flatten(m), 220)).append('\n'));
    }

    /** A map row as a readable line — the model reads prose far better than raw JSON. */
    private static String flatten(Map<String, Object> m) {
        StringBuilder s = new StringBuilder();
        for (Map.Entry<String, Object> e : m.entrySet()) {
            if (e.getValue() == null || String.valueOf(e.getValue()).isBlank()) continue;
            if (s.length() > 0) s.append(" · ");
            s.append(e.getValue());
        }
        return s.toString();
    }

    private int keywordScore(String title, String company, String location, String description) {
        try {
            com.jobpilot.domain.Job j = new com.jobpilot.domain.Job();
            j.setTitle(title); j.setCompany(company); j.setLocation(location); j.setDescription(description);
            j.setPostedAt(java.time.Instant.now());
            return clamp(scorer.score(j, profiles.get()));
        } catch (Exception e) {
            return 0;
        }
    }

    /** Models like to wrap JSON in prose or ```json fences — take the outermost object. */
    JsonNode parseJson(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        int a = s.indexOf('{'), z = s.lastIndexOf('}');
        if (a < 0 || z <= a) return null;
        try { return json.readTree(s.substring(a, z + 1)); } catch (Exception e) { return null; }
    }

    private static List<String> strings(JsonNode n) {
        if (n == null || !n.isArray()) return List.of();
        List<String> out = new ArrayList<>();
        n.forEach(x -> { if (notBlank(x.asText())) out.add(x.asText()); });
        return out;
    }

    private static int clamp(int v) { return Math.max(0, Math.min(100, v)); }
    private static boolean notBlank(String s) { return s != null && !s.isBlank(); }
    private static String nz(String s) { return s == null ? "" : s; }
    private static String trim(String s, int max) { return s.length() <= max ? s : s.substring(0, max); }
}
