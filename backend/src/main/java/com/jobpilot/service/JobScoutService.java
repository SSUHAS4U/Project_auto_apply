package com.jobpilot.service;

import com.jobpilot.connector.FetchParams;
import com.jobpilot.connector.JobConnector;
import com.jobpilot.connector.RawJob;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.domain.ScoutedJob;
import com.jobpilot.repository.ProfileRepository;
import com.jobpilot.repository.ScoutedJobRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.client.RestClient;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The automated job scout. Runs hourly (see DailyScheduler) and fills the
 * dashboard's "Scout" section with refined, resume-relevant listings from
 * LinkedIn / Naukri / Indeed — found through FREE, keyless channels only:
 *
 *  - LinkedIn's public guest jobs endpoint (direct /jobs/view links, last 3 days);
 *  - Jooble + Careerjet APIs (both free tiers), which aggregate Naukri/Indeed/
 *    LinkedIn postings and deep-link to the originals.
 *
 * Every hit is filtered (tech-role check + resume match score), deduped by URL,
 * and mined for CONTACT DETAILS (emails/phones in the listing text) so the user
 * can reach out directly. Results expire after 7 days.
 */
@Service
public class JobScoutService {

    private static final Logger log = LoggerFactory.getLogger(JobScoutService.class);

    @org.springframework.beans.factory.annotation.Value("${jobpilot.scout.min-score:35}")
    private int minScore;

    @org.springframework.beans.factory.annotation.Value("${jobpilot.scout.retention-days:7}")
    private int retentionDays;

    private static final Pattern EMAIL =
            Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}");
    private static final Pattern PHONE =
            Pattern.compile("(?:\\+91[\\s-]?)?[6-9]\\d{4}[\\s-]?\\d{5}");

    private final ScoutedJobRepository scoutRepo;
    private final ProfileRepository profileRepo;
    private final List<JobConnector> connectors;
    private final NormalizeService normalize;
    private final MatchScorer scorer;
    private final RestClient http;

    public JobScoutService(ScoutedJobRepository scoutRepo, ProfileRepository profileRepo,
                           List<JobConnector> connectors, NormalizeService normalize,
                           MatchScorer scorer, RestClient http) {
        this.scoutRepo = scoutRepo;
        this.profileRepo = profileRepo;
        this.connectors = connectors;
        this.normalize = normalize;
        this.scorer = scorer;
        this.http = http;
    }

    /** One scout run. @return summary counts per source/channel + totals. */
    @Transactional
    public Map<String, Object> run() {
        Profile profile = profileRepo.findFirstByOrderByUpdatedAtAsc().orElse(null);
        List<String> keywords = keywords(profile);
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("keywords", keywords);
        Map<String, String> channels = new LinkedHashMap<>();
        Map<String, Integer> bySite = new LinkedHashMap<>();

        int found = 0, kept = 0;

        // 1. LinkedIn guest search — the free public endpoint the logged-out /jobs page
        //    uses; keyless and returns DIRECT linkedin.com/jobs/view links.
        List<ScoutedJob> li = fromLinkedIn(keywords, channels);
        found += li.size();
        kept += upsertAll(li, profile, keywords, bySite);

        // 2. Jooble + Careerjet — aggregate Naukri/Indeed/LinkedIn and deep-link out.
        for (JobConnector c : connectors) {
            if (!("jooble".equals(c.source()) || "careerjet".equals(c.source()))) continue;
            if (!c.isConfigured()) { channels.put(c.source(), "not configured"); continue; }
            int chFound = 0;
            String err = null;
            for (String kw : keywords) {
                try {
                    List<RawJob> batch = c.fetch(FetchParams.builder().query(kw).where("India").build());
                    chFound += batch.size();
                    kept += upsertAll(batch.stream().map(this::fromRaw).toList(), profile, keywords, bySite);
                } catch (Exception e) {
                    err = e.getMessage();
                    log.warn("Scout {} query '{}' failed: {}", c.source(), kw, e.getMessage());
                }
            }
            found += chFound;
            channels.put(c.source(), chFound == 0 && err != null ? "error: " + err : "ok · " + chFound + " found");
        }

        int purged = scoutRepo.deleteOlderThan(Instant.now().minus(Duration.ofDays(retentionDays)));
        summary.put("found", found);
        summary.put("kept", kept);
        summary.put("purged", purged);
        summary.put("total", scoutRepo.count());
        summary.put("bySite", bySite);
        summary.put("channels", channels);
        log.info("Scout run complete: {}", summary);
        return summary;
    }

    public List<ScoutedJob> latest(int limit) {
        return scoutRepo.findByOrderByFetchedAtDescMatchScoreDesc(
                org.springframework.data.domain.PageRequest.of(0, Math.min(Math.max(limit, 1), 500)));
    }

    @Transactional
    public void delete(java.util.UUID id) {
        scoutRepo.deleteById(id);
    }

    // ---- sources --------------------------------------------------------------

    private static final String BROWSER_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
    private static final Pattern LI_CARD = Pattern.compile("<li>(.+?)</li>", Pattern.DOTALL);
    private static final Pattern LI_LINK = Pattern.compile("base-card__full-link[^\"]*\"\\s+href=\"([^\"]+)\"");
    private static final Pattern LI_TITLE = Pattern.compile("base-search-card__title\">\\s*(.+?)\\s*</h3>", Pattern.DOTALL);
    private static final Pattern LI_COMPANY = Pattern.compile("hidden-nested-link\"[^>]*>\\s*(.+?)\\s*</a>", Pattern.DOTALL);
    private static final Pattern LI_LOCATION = Pattern.compile("job-search-card__location\">\\s*(.+?)\\s*</span>", Pattern.DOTALL);
    private static final Pattern LI_TIME = Pattern.compile("<time[^>]*>\\s*(.+?)\\s*</time>", Pattern.DOTALL);

    /**
     * LinkedIn's public guest jobs endpoint — the same one the logged-out /jobs page calls.
     * Free, keyless, direct linkedin.com/jobs/view links, filtered to the last 3 days.
     * Two keywords per run (rotating by hour through the list) keeps request volume polite;
     * over a day every keyword gets searched several times. Naukri and Indeed postings
     * arrive through the Jooble/Careerjet aggregators (their public APIs are captcha-gated).
     */
    private List<ScoutedJob> fromLinkedIn(List<String> keywords, Map<String, String> channels) {
        List<ScoutedJob> out = new ArrayList<>();
        int hour = java.time.LocalTime.now().getHour();
        String err = null;
        for (int i = 0; i < Math.min(2, keywords.size()); i++) {
            String kw = keywords.get((hour + i) % keywords.size());
            try {
                String html = http.get().uri(uri -> uri
                                .scheme("https").host("www.linkedin.com")
                                .path("/jobs-guest/jobs/api/seeMoreJobPostings/search")
                                .queryParam("keywords", kw)
                                .queryParam("location", "India")
                                .queryParam("f_TPR", "r259200") // posted in the last 3 days
                                .queryParam("start", 0)
                                .build())
                        .header("User-Agent", BROWSER_UA)
                        .retrieve().body(String.class);
                if (html == null) continue;
                Matcher card = LI_CARD.matcher(html);
                while (card.find()) {
                    String c = card.group(1);
                    String url = find(LI_LINK, c);
                    String title = find(LI_TITLE, c);
                    if (url == null || title == null) continue;
                    ScoutedJob s = new ScoutedJob();
                    s.setTitle(htmlText(title));
                    s.setUrl(htmlText(url).replaceAll("[?#].*$", ""));
                    s.setCompany(htmlText(find(LI_COMPANY, c)));
                    s.setLocation(htmlText(find(LI_LOCATION, c)));
                    s.setPostedHint(htmlText(find(LI_TIME, c)));
                    s.setSourceSite("linkedin");
                    // The search itself ran on this keyword; list cards carry no
                    // description to re-check against, so record it as the match.
                    s.setMatchedKeywords(kw.replace(" developer", "").trim());
                    out.add(s);
                }
            } catch (Exception e) {
                err = e.getMessage();
                log.warn("Scout LinkedIn '{}' failed: {}", kw, e.getMessage());
            }
        }
        channels.put("linkedin", out.isEmpty() && err != null
                ? "error: " + err : "ok · " + out.size() + " found");
        return out;
    }

    private static String find(Pattern p, String text) {
        Matcher m = p.matcher(text);
        return m.find() ? m.group(1) : null;
    }

    /** Strip tags and decode the handful of HTML entities these fragments use. */
    private static String htmlText(String s) {
        if (s == null) return null;
        return s.replaceAll("<[^>]+>", " ")
                .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
                .replaceAll("\\s+", " ").trim();
    }

    private ScoutedJob fromRaw(RawJob r) {
        ScoutedJob s = new ScoutedJob();
        s.setTitle(r.getTitle() == null ? "" : r.getTitle());
        s.setCompany(r.getCompany());
        s.setLocation(r.getLocation());
        s.setUrl(r.getUrl() == null ? "" : r.getUrl());
        s.setSnippet(clean(r.getDescription()));
        s.setSourceSite(hostSite(r.getUrl()));
        if (r.getPostedAt() != null) s.setPostedHint(r.getPostedAt().toString());
        return s;
    }

    // ---- refine + persist -------------------------------------------------------

    /** Filter to fresh, tech, resume-relevant results; mine contacts; upsert by URL. */
    private int upsertAll(List<ScoutedJob> batch, Profile profile, List<String> keywords,
                          Map<String, Integer> bySite) {
        int kept = 0;
        for (ScoutedJob s : batch) {
            if (s.getUrl() == null || s.getUrl().isBlank() || s.getTitle().isBlank()) continue;
            String titleForCheck = s.getTitle().replaceAll("\\s*[|·–-]\\s*(LinkedIn|Naukri(\\.com)?|Indeed(\\.com)?).*$", "");
            if (!normalize.isTechRole(titleForCheck)) continue;

            String text = (s.getTitle() + " " + (s.getSnippet() == null ? "" : s.getSnippet()));
            String matched = matchedKeywords(text, keywords, profile);
            if (matched == null) matched = s.getMatchedKeywords(); // e.g. the LinkedIn search keyword

            // Resume relevance: score title+snippet like a normal listing. Search-result
            // snippets (~160 chars) are far too thin to hit a full-description threshold,
            // so for those a title/skill keyword hit is enough to keep the listing.
            if (profile != null && profile.getSkills() != null && !profile.getSkills().isEmpty()) {
                Job tmp = new Job();
                tmp.setTitle(titleForCheck);
                tmp.setDescription(s.getSnippet());
                tmp.setLocation(s.getLocation());
                int score = scorer.score(tmp, profile);
                s.setMatchScore(score);
                boolean thin = text.length() < 300;
                if (thin ? (matched == null && score < minScore / 2) : score < minScore) continue;
            }

            s.setEmails(joinMatches(EMAIL, text, 3));
            s.setPhones(joinMatches(PHONE, text, 3));
            s.setMatchedKeywords(matched);
            if (s.getSourceSite() == null) s.setSourceSite(hostSite(s.getUrl()));
            if (s.getPostedHint() == null) s.setPostedHint(postedHintFrom(s.getSnippet()));

            String hash = sha256(s.getUrl().replaceAll("[?#].*$", "").toLowerCase(Locale.ROOT));
            ScoutedJob existing = scoutRepo.findByUrlHash(hash).orElse(null);
            if (existing != null) {
                existing.setFetchedAt(Instant.now());
                if (s.getMatchScore() != null) existing.setMatchScore(s.getMatchScore());
                scoutRepo.save(existing);
                continue;
            }
            s.setUrlHash(hash);
            s.setFetchedAt(Instant.now());
            try {
                scoutRepo.save(s);
                kept++;
                bySite.merge(s.getSourceSite() == null ? "other" : s.getSourceSite(), 1, Integer::sum);
            } catch (org.springframework.dao.DataIntegrityViolationException dup) {
                // raced with a concurrent run — skip
            }
        }
        return kept;
    }

    // ---- keyword derivation ------------------------------------------------------

    /**
     * Search phrases scanned from the WHOLE profile, most specific first:
     *  1. current role title / headline, qualified with the experience level;
     *  2. role titles from the profile's experience entries;
     *  3. the top-two-skills combo ("react node.js developer") then single-skill phrases;
     *  4. a level-qualified generic ("fresher software developer").
     * The experience level (fresher/junior/senior) comes from years_experience or seniority.
     */
    List<String> keywords(Profile p) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        if (p != null) {
            String level = experienceLevel(p);
            addRolePhrase(out, firstNonBlank(p.getCurrentTitle(), p.getHeadline()), level);
            if (p.getExperience() != null) {
                for (Map<String, Object> e : p.getExperience()) {
                    if (out.size() >= 3) break;
                    addRolePhrase(out, firstString(e.get("title"), e.get("role"), e.get("position")), null);
                }
            }
            List<String> skills = new ArrayList<>();
            if (p.getSkills() != null) {
                for (String s : p.getSkills()) {
                    if (s != null && !s.isBlank()) skills.add(s.toLowerCase(Locale.ROOT).trim());
                }
            }
            if (skills.size() >= 2) out.add(skills.get(0) + " " + skills.get(1) + " developer");
            for (String s : skills) {
                if (out.size() >= 7) break;
                out.add(s + " developer");
            }
            if (level != null && out.size() < 8) out.add(level + " software developer");
        }
        if (out.isEmpty()) out.add("software engineer");
        List<String> list = new ArrayList<>(out);
        return list.subList(0, Math.min(8, list.size()));
    }

    /** Keep the first role-looking phrase of a title, e.g. "java backend developer". */
    private static void addRolePhrase(Set<String> out, String raw, String level) {
        if (raw == null || raw.isBlank()) return;
        String t = raw.split("[|,•@(]")[0].trim();
        if (t.length() <= 3 || t.length() >= 60) return;
        String phrase = t.toLowerCase(Locale.ROOT);
        out.add(level != null && !phrase.contains(level) ? level + " " + phrase : phrase);
    }

    /** fresher (<1y) / junior (<3y) / senior (7y+) from years_experience, or the seniority field. */
    private static String experienceLevel(Profile p) {
        if (p.getSeniority() != null) {
            String s = p.getSeniority().toLowerCase(Locale.ROOT).trim();
            if (s.matches("fresher|junior|senior|lead|intern")) return s;
        }
        String y = p.getYearsExperience();
        if (y == null) return null;
        Matcher m = Pattern.compile("\\d+(?:\\.\\d+)?").matcher(y);
        if (!m.find()) return null;
        double years = Double.parseDouble(m.group());
        if (years < 1) return "fresher";
        if (years < 3) return "junior";
        if (years >= 7) return "senior";
        return null; // mid-level: leave queries unqualified
    }

    private static String firstString(Object... vals) {
        for (Object v : vals) if (v instanceof String s && !s.isBlank()) return s;
        return null;
    }

    // ---- small helpers -------------------------------------------------------------

    private static String joinMatches(Pattern p, String text, int max) {
        if (text == null) return null;
        Set<String> found = new LinkedHashSet<>();
        Matcher m = p.matcher(text);
        while (m.find() && found.size() < max) {
            String v = m.group().trim();
            if (!v.toLowerCase(Locale.ROOT).contains("noreply")) found.add(v);
        }
        return found.isEmpty() ? null : String.join(", ", found);
    }

    /** Which of the search keywords AND profile skills actually appear in the listing text. */
    private static String matchedKeywords(String text, List<String> keywords, Profile p) {
        String low = text.toLowerCase(Locale.ROOT);
        Set<String> hits = new LinkedHashSet<>();
        for (String kw : keywords) {
            String core = kw.replace(" developer", "").trim();
            if (!core.isEmpty() && low.contains(core)) hits.add(core);
        }
        if (p != null && p.getSkills() != null) {
            for (String skill : p.getSkills()) {
                if (hits.size() >= 8) break;
                if (skill == null || skill.trim().length() < 3) continue;
                String sk = skill.toLowerCase(Locale.ROOT).trim();
                if (low.contains(sk)) hits.add(sk);
            }
        }
        return hits.isEmpty() ? null : String.join(", ", hits);
    }

    private static final Pattern POSTED = Pattern.compile(
            "(\\d+\\s*(?:hours?|days?|weeks?)\\s*ago|today|yesterday|just posted)", Pattern.CASE_INSENSITIVE);

    private static String postedHintFrom(String snippet) {
        if (snippet == null) return null;
        Matcher m = POSTED.matcher(snippet);
        return m.find() ? m.group(1) : null;
    }

    private static String hostSite(String url) {
        if (url == null) return "other";
        String u = url.toLowerCase(Locale.ROOT);
        if (u.contains("linkedin.")) return "linkedin";
        if (u.contains("naukri.")) return "naukri";
        if (u.contains("indeed.")) return "indeed";
        if (u.contains("jooble.")) return "jooble";
        if (u.contains("careerjet.")) return "careerjet";
        if (u.contains("google.")) return "google";
        return "other";
    }

    private static String clean(String s) {
        return s == null ? null : s.replaceAll("\\s+", " ").trim();
    }

    private static String firstNonBlank(String a, String b) {
        if (a != null && !a.isBlank()) return a;
        if (b != null && !b.isBlank()) return b;
        return null;
    }

    private static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
