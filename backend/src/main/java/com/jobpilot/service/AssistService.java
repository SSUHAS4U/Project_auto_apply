package com.jobpilot.service;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.domain.QaPair;
import com.jobpilot.repository.QaPairRepository;
import com.jobpilot.security.UserContext;
import com.jobpilot.service.ai.AiService;
import com.jobpilot.service.cover.CoverLetterService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Powers the extension's assisted-apply features: answering free-text application
 * questions with AI (grounded in the user's profile), a reusable Q&A bank, and
 * on-demand cover letters.
 */
@Service
public class AssistService {

    private static final String ANSWER_SYSTEM = """
            You are a career coach helping a candidate answer job-application questions in the
            BEST HONEST LIGHT. Write a confident first-person answer grounded in the candidate's
            background below.
            - For questions about a skill/tool the candidate may not have explicitly listed
              (e.g. "describe your exposure to PyTorch", "experience with Kubernetes"), do NOT
              say they have none. Give a constructive, basic-but-confident answer: connect their
              real foundation (programming, CS fundamentals, related tools) to the topic and show
              genuine eagerness and fast-learning. Claim FOUNDATIONAL / working familiarity — not
              deep expertise — so it stays believable.
            - Be specific, genuine and concise (2-5 sentences unless more is clearly needed).
            - Don't fabricate specific employers, degrees, projects or year counts — keep it about
              capability and approach. No placeholders, no markdown, no preamble — output ONLY the answer.""";

    private final QaPairRepository qaRepo;
    private final ProfileService profiles;
    private final AiService ai;
    private final CoverLetterService coverLetters;

    public AssistService(QaPairRepository qaRepo, ProfileService profiles,
                         AiService ai, CoverLetterService coverLetters) {
        this.qaRepo = qaRepo;
        this.profiles = profiles;
        this.ai = ai;
        this.coverLetters = coverLetters;
    }

    /** Answer a question — reuse a saved answer if we have a close match, else ask AI (and store it). */
    @Transactional
    public Map<String, Object> answer(String question) {
        if (question == null || question.isBlank()) {
            throw new IllegalArgumentException("question is required");
        }
        UUID userId = UserContext.require();
        String key = normalize(question);

        // 1. Exact key match in the bank.
        Optional<QaPair> exact = qaRepo.findByUserIdAndQuestionKey(userId, key);
        if (exact.isPresent()) {
            return Map.of("answer", exact.get().getAnswer(), "source", "saved");
        }
        // 2. Fuzzy match against the bank (token overlap) — reuse a similar answer.
        QaPair similar = bestMatch(qaRepo.findByUserIdOrderByUpdatedAtDesc(userId), key);
        if (similar != null) {
            return Map.of("answer", similar.getAnswer(), "source", "saved");
        }
        // 3. Generate with AI, grounded in the profile. Do NOT auto-save — only the
        //    user's explicit "Save" should add an answer to the reusable bank.
        Profile p = profiles.get();
        String prompt = "Candidate background:\n" + profileContext(p)
                + "\n\nApplication question: " + question.trim() + "\n\nAnswer:";
        String generated = ai.complete(ANSWER_SYSTEM, prompt, false, false).trim();
        return Map.of("answer", generated, "source", "ai");
    }

    /**
     * Pick the best option(s) for a multiple-choice / dropdown / rating question,
     * grounded in the candidate's profile. Returns option labels exactly as given.
     */
    public Map<String, Object> choose(String question, List<String> options, boolean multi) {
        if (question == null || question.isBlank() || options == null || options.isEmpty()) {
            throw new IllegalArgumentException("question and options are required");
        }
        Profile p = profiles.get();
        StringBuilder opts = new StringBuilder();
        for (int i = 0; i < options.size(); i++) {
            opts.append(i + 1).append(". ").append(options.get(i)).append("\n");
        }
        String system = """
                You help a candidate answer multiple-choice / rating questions to PASS screening
                while staying broadly truthful — like a career coach.
                - For SKILL exposure / familiarity / "do you have knowledge of X" questions, prefer
                  the AFFIRMATIVE option (Yes, or a mid-to-high rating). A software engineer can
                  honestly claim basic working familiarity with common technologies and is a fast
                  learner — avoid "No" / "None of the above" unless an option is clearly impossible.
                - For rating scales (1-10), pick a solid mid-to-high number (around 6-8) reflecting
                  transferable ability — never the lowest.
                - For hard eligibility facts (location, relocation, start date, work authorization),
                  stay honest and eligibility-friendly (e.g. willing to relocate / can start soon).
                Reply with ONLY the option number(s); separate multiple with commas. Just numbers.""";
        String prompt = "Candidate background:\n" + profileContext(p)
                + "\n\nQuestion: " + question.trim()
                + "\n\nOptions:\n" + opts
                + "\n" + (multi ? "Select all that apply." : "Select exactly one.")
                + " Reply with the number(s) only:";
        String raw = ai.complete(system, prompt, true, false);

        List<String> selected = new ArrayList<>();
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\d+").matcher(raw == null ? "" : raw);
        while (m.find()) {
            int idx = Integer.parseInt(m.group()) - 1;
            if (idx >= 0 && idx < options.size() && !selected.contains(options.get(idx))) {
                selected.add(options.get(idx));
                if (!multi) break;
            }
        }
        if (selected.isEmpty() && !multi) selected.add(options.get(0)); // safe fallback
        return Map.of("selected", selected);
    }

    /**
     * Map a batch of form-field labels to concrete answers from the candidate's full
     * profile. Lets the extension fill fields the synonym engine misses (CTC, college,
     * coding-profile links, etc.) by actually understanding each label.
     */
    public Map<String, String> autofill(List<String> fields) {
        if (fields == null || fields.isEmpty()) return Map.of();
        Profile p = profiles.get();
        List<String> clean = fields.stream().filter(f -> f != null && !f.isBlank())
                .map(String::trim).distinct().limit(40).toList();
        if (clean.isEmpty()) return Map.of();

        StringBuilder list = new StringBuilder();
        for (String f : clean) list.append("- ").append(f).append("\n");

        String system = """
                You fill out job-application form fields from a candidate's profile. You are given
                the full profile and a list of field labels. Return a JSON object mapping EACH label
                (verbatim) to the best answer drawn ONLY from the profile. Rules:
                - Use the literal value for factual fields (CTC as the number, links as the full URL,
                  notice period, college name, location, etc.).
                - If the profile has no data for a field, map it to "" (empty string) — never invent.
                - Keep answers short and form-appropriate. Output ONLY the JSON object.""";
        String prompt = "PROFILE:\n" + fullProfileContext(p) + "\n\nFIELDS:\n" + list + "\nJSON:";

        try {
            String raw = ai.complete(system, prompt, true, false);
            com.fasterxml.jackson.databind.JsonNode json = new com.fasterxml.jackson.databind.ObjectMapper().readTree(stripFence(raw));
            Map<String, String> out = new LinkedHashMap<>();
            for (String f : clean) {
                String v = json.path(f).asText("");
                if (v != null && !v.isBlank() && !"null".equalsIgnoreCase(v)) out.put(f, v.trim());
            }
            return out;
        } catch (Exception e) {
            return Map.of();
        }
    }

    /**
     * Side-panel copilot: interpret a free-form instruction about the current page and
     * return a structured action — fill a specific field, answer a question to paste, or reply.
     */
    public Map<String, Object> command(String instruction, List<String> fields) {
        if (instruction == null || instruction.isBlank()) throw new IllegalArgumentException("instruction is required");
        Profile p = profiles.get();
        String list = fields == null ? "" : fields.stream().filter(f -> f != null && !f.isBlank())
                .map(String::trim).distinct().limit(60).map(f -> "- " + f).reduce("", (a, b) -> a + b + "\n");

        String system = """
                You are a form-filling copilot inside a browser side panel. Given the user's
                instruction, the fields visible on the current page, and the candidate's profile,
                respond with STRICT JSON only (no prose), choosing ONE action:
                - Fill a field:   {"action":"fill","field":"<EXACT label from the field list>","value":"<value>"}
                - Answer to paste:{"action":"answer","value":"<concise, honest answer>"}
                - Save a Q&A:     {"action":"save","question":"<question>","answer":"<answer>"}
                - Plain reply:    {"action":"reply","message":"<short reply>"}
                Use the profile for facts. Act as a career coach: present the candidate in the
                best honest light. For skill questions ("Exposure to PyTorch?"), do NOT say "no" —
                claim basic/foundational familiarity and eagerness to learn (a software engineer
                can plausibly claim working familiarity with common tech). Never fabricate
                employers, degrees or year counts.""";
        String prompt = "PROFILE:\n" + fullProfileContext(p)
                + "\n\nFIELDS ON PAGE:\n" + (list.isBlank() ? "(none detected)" : list)
                + "\nUSER INSTRUCTION: " + instruction.trim() + "\n\nJSON:";

        try {
            String raw = ai.complete(system, prompt, false, false);
            com.fasterxml.jackson.databind.JsonNode j = new com.fasterxml.jackson.databind.ObjectMapper().readTree(stripFence(raw));
            String action = j.path("action").asText("reply");
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("action", action);
            if (j.has("field")) out.put("field", j.path("field").asText(""));
            if (j.has("value")) out.put("value", j.path("value").asText(""));
            if (j.has("question")) out.put("question", j.path("question").asText(""));
            if (j.has("answer")) out.put("answer", j.path("answer").asText(""));
            if (j.has("message")) out.put("message", j.path("message").asText(""));
            // Auto-persist a save action.
            if ("save".equals(action) && j.has("question") && j.has("answer")) {
                saveQa(j.path("question").asText(), j.path("answer").asText());
            }
            return out;
        } catch (Exception e) {
            return Map.of("action", "reply", "message", "Sorry, I couldn't process that: " + e.getMessage());
        }
    }

    private static String stripFence(String s) {
        if (s == null) return "{}";
        String t = s.trim();
        if (t.startsWith("```")) t = t.replaceAll("(?s)```(json)?", "").trim();
        int a = t.indexOf('{'), b = t.lastIndexOf('}');
        return (a >= 0 && b > a) ? t.substring(a, b + 1) : t;
    }

    private String fullProfileContext(Profile p) {
        StringBuilder sb = new StringBuilder();
        line(sb, "Full name", p.getFullName());
        line(sb, "Email", p.getEmail());
        line(sb, "Phone", p.getPhone());
        line(sb, "Location", p.getLocation());
        line(sb, "City", p.getCity());
        line(sb, "State", p.getState());
        line(sb, "Country", p.getCountry());
        line(sb, "Postal code", p.getPostalCode());
        line(sb, "College / University", p.getCollege());
        line(sb, "Headline", p.getHeadline());
        line(sb, "Current role", join(p.getCurrentTitle(), p.getCurrentCompany()));
        line(sb, "Years of experience", str(p.getYearsExperience()));
        line(sb, "Seniority", p.getSeniority());
        line(sb, "Current CTC / salary", p.getCurrentCtc());
        line(sb, "Expected CTC / salary", p.getExpectedCtc());
        line(sb, "Notice period", p.getNoticePeriod());
        line(sb, "Available from", p.getAvailableFrom());
        line(sb, "Work authorization", p.getWorkAuthorization());
        line(sb, "Willing to relocate", p.getWillingToRelocate() == null ? null : (p.getWillingToRelocate() ? "Yes" : "No"));
        if (p.getSkills() != null && !p.getSkills().isEmpty()) line(sb, "Skills", String.join(", ", p.getSkills()));
        if (p.getLinks() != null) p.getLinks().forEach((k, v) -> line(sb, "Link (" + k + ")", v));
        line(sb, "Summary", p.getSummary());
        return sb.length() == 0 ? "(no profile details)" : sb.toString();
    }

    @Transactional
    public QaPair saveQa(String question, String answer) {
        if (question == null || question.isBlank() || answer == null || answer.isBlank()) {
            throw new IllegalArgumentException("question and answer are required");
        }
        return save(UserContext.require(), question, answer, "manual");
    }

    public List<QaPair> listQa() {
        return qaRepo.findByUserIdOrderByUpdatedAtDesc(UserContext.require());
    }

    @Transactional
    public void deleteQa(UUID id) {
        UUID userId = UserContext.require();
        qaRepo.findById(id).filter(q -> userId.equals(q.getUserId())).ifPresent(qaRepo::delete);
    }

    /** Generate a cover letter for an arbitrary listing the extension is looking at. */
    public String coverLetter(String company, String role, String jobText) {
        Profile p = profiles.get();
        Job job = new Job();
        job.setCompany(company == null || company.isBlank() ? "the company" : company.trim());
        job.setTitle(role == null || role.isBlank() ? "this role" : role.trim());
        job.setDescription(jobText == null ? "" : jobText.trim());
        return coverLetters.generate(job, p);
    }

    // ---- internals ----

    private QaPair save(UUID userId, String question, String answer, String source) {
        String key = normalize(question);
        QaPair q = qaRepo.findByUserIdAndQuestionKey(userId, key).orElseGet(QaPair::new);
        q.setUserId(userId);
        q.setQuestion(question.trim());
        q.setQuestionKey(key);
        q.setAnswer(answer.trim());
        if (q.getId() == null) q.setSource(source);
        q.setUpdatedAt(Instant.now());
        return qaRepo.save(q);
    }

    private static String normalize(String s) {
        return s.toLowerCase().replaceAll("[^a-z0-9 ]", " ").replaceAll("\\s+", " ").trim();
    }

    /** Returns a stored Q&A whose question tokens overlap the asked one strongly (Jaccard >= 0.6). */
    private QaPair bestMatch(List<QaPair> bank, String key) {
        Set<String> want = tokens(key);
        if (want.isEmpty()) return null;
        QaPair best = null;
        double bestScore = 0.6;
        for (QaPair q : bank) {
            Set<String> have = tokens(q.getQuestionKey());
            if (have.isEmpty()) continue;
            Set<String> inter = new HashSet<>(want);
            inter.retainAll(have);
            Set<String> union = new HashSet<>(want);
            union.addAll(have);
            double j = (double) inter.size() / union.size();
            if (j > bestScore) { bestScore = j; best = q; }
        }
        return best;
    }

    private static Set<String> tokens(String key) {
        return Arrays.stream(key.split(" ")).filter(t -> t.length() > 2).collect(Collectors.toSet());
    }

    private String profileContext(Profile p) {
        StringBuilder sb = new StringBuilder();
        line(sb, "Name", p.getFullName());
        line(sb, "Headline", p.getHeadline());
        line(sb, "Current role", join(p.getCurrentTitle(), p.getCurrentCompany()));
        line(sb, "Years of experience", str(p.getYearsExperience()));
        line(sb, "Location", p.getLocation());
        if (p.getSkills() != null && !p.getSkills().isEmpty()) {
            line(sb, "Skills", String.join(", ", p.getSkills()));
        }
        line(sb, "Summary", p.getSummary());
        return sb.length() == 0 ? "(no profile details on file)" : sb.toString();
    }

    private static void line(StringBuilder sb, String label, String val) {
        if (val != null && !val.isBlank()) sb.append("- ").append(label).append(": ").append(val).append("\n");
    }

    private static String join(String a, String b) {
        if (a == null || a.isBlank()) return b;
        if (b == null || b.isBlank()) return a;
        return a + " at " + b;
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }
}
