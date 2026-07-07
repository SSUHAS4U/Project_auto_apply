package com.jobpilot.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
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
 * The automated job scout. Runs 4-5x/day (see DailyScheduler) and fills the
 * dashboard's "Scout" section with refined, resume-relevant listings from
 * LinkedIn / Naukri / Indeed / Google — found through FREE channels only:
 *
 *  - Google CSE (100 free queries/day) restricted per job site, last-3-days results;
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
    private final JobPilotProperties props;

    public JobScoutService(ScoutedJobRepository scoutRepo, ProfileRepository profileRepo,
                           List<JobConnector> connectors, NormalizeService normalize,
                           MatchScorer scorer, RestClient http, JobPilotProperties props) {
        this.scoutRepo = scoutRepo;
        this.profileRepo = profileRepo;
        this.connectors = connectors;
        this.normalize = normalize;
        this.scorer = scorer;
        this.http = http;
        this.props = props;
    }

    /** One scout run. @return summary counts per source + totals. */
    @Transactional
    public Map<String, Object> run() {
        Profile profile = profileRepo.findFirstByOrderByUpdatedAtAsc().orElse(null);
        List<String> keywords = keywords(profile);
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("keywords", keywords);

        int found = 0, kept = 0;

        // 1. Google CSE — per-site fresh results (linkedin / naukri / indeed + open web).
        List<ScoutedJob> cse = fromGoogleCse(keywords);
        found += cse.size();
        kept += upsertAll(cse, profile, keywords);

        // 2. Jooble + Careerjet — aggregate Naukri/Indeed/LinkedIn and deep-link out.
        for (JobConnector c : connectors) {
            if (!("jooble".equals(c.source()) || "careerjet".equals(c.source())) || !c.isConfigured()) continue;
            for (String kw : keywords) {
                try {
                    List<RawJob> batch = c.fetch(FetchParams.builder().query(kw).where("India").build());
                    found += batch.size();
                    kept += upsertAll(batch.stream().map(this::fromRaw).toList(), profile, keywords);
                } catch (Exception e) {
                    log.debug("Scout {} query '{}' failed: {}", c.source(), kw, e.getMessage());
                }
            }
        }

        int purged = scoutRepo.deleteOlderThan(Instant.now().minus(Duration.ofDays(retentionDays)));
        summary.put("found", found);
        summary.put("kept", kept);
        summary.put("purged", purged);
        summary.put("total", scoutRepo.count());
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

    /** Search each job site through Google CSE for postings indexed in the last 3 days. */
    private List<ScoutedJob> fromGoogleCse(List<String> keywords) {
        JobPilotProperties.GoogleCse g = props.getGoogleCse();
        List<ScoutedJob> out = new ArrayList<>();
        if (isBlank(g.getApiKey()) || isBlank(g.getCx())) return out;

        String[][] sites = {
                {"linkedin", "site:linkedin.com/jobs"},
                {"naukri", "site:naukri.com"},
                {"indeed", "site:indeed.com"},
        };
        // Budget: 3 sites x up to 3 keywords = 9 calls/run, 5 runs/day = 45 of the 100 free.
        List<String> kws = keywords.subList(0, Math.min(3, keywords.size()));
        for (String[] site : sites) {
            for (String kw : kws) {
                try {
                    JsonNode root = http.get().uri(uri -> uri
                                    .scheme("https").host("customsearch.googleapis.com").path("/customsearch/v1")
                                    .queryParam("key", g.getApiKey())
                                    .queryParam("cx", g.getCx())
                                    .queryParam("q", site[1] + " " + kw + " India")
                                    .queryParam("num", 10)
                                    .queryParam("dateRestrict", "d3")
                                    .queryParam("gl", "in")
                                    .build())
                            .retrieve().body(JsonNode.class);
                    if (root == null || !root.has("items")) continue;
                    for (JsonNode it : root.get("items")) {
                        ScoutedJob s = new ScoutedJob();
                        s.setTitle(clean(it.path("title").asText("")));
                        s.setUrl(it.path("link").asText(""));
                        s.setSnippet(clean(it.path("snippet").asText("")));
                        s.setSourceSite(site[0]);
                        out.add(s);
                    }
                } catch (Exception e) {
                    log.debug("Scout CSE '{}' on {} failed: {}", kw, site[0], e.getMessage());
                }
            }
        }
        return out;
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
    private int upsertAll(List<ScoutedJob> batch, Profile profile, List<String> keywords) {
        int kept = 0;
        for (ScoutedJob s : batch) {
            if (s.getUrl() == null || s.getUrl().isBlank() || s.getTitle().isBlank()) continue;
            String titleForCheck = s.getTitle().replaceAll("\\s*[|·–-]\\s*(LinkedIn|Naukri(\\.com)?|Indeed(\\.com)?).*$", "");
            if (!normalize.isTechRole(titleForCheck)) continue;

            // Resume relevance: score title+snippet like a normal job listing.
            if (profile != null && profile.getSkills() != null && !profile.getSkills().isEmpty()) {
                Job tmp = new Job();
                tmp.setTitle(titleForCheck);
                tmp.setDescription(s.getSnippet());
                tmp.setLocation(s.getLocation());
                int score = scorer.score(tmp, profile);
                if (score < minScore) continue;
                s.setMatchScore(score);
            }

            String text = (s.getTitle() + " " + (s.getSnippet() == null ? "" : s.getSnippet()));
            s.setEmails(joinMatches(EMAIL, text, 3));
            s.setPhones(joinMatches(PHONE, text, 3));
            s.setMatchedKeywords(matchedKeywords(text, keywords));
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
            } catch (org.springframework.dao.DataIntegrityViolationException dup) {
                // raced with a concurrent run — skip
            }
        }
        return kept;
    }

    // ---- keyword derivation ------------------------------------------------------

    /** Resume-driven search phrases: top skills as "<skill> developer", plus the role itself. */
    List<String> keywords(Profile p) {
        Set<String> out = new LinkedHashSet<>();
        if (p != null) {
            String title = firstNonBlank(p.getCurrentTitle(), p.getHeadline());
            if (title != null) {
                // Keep the first role-looking phrase, e.g. "Java backend developer".
                String t = title.split("[|,•]")[0].trim();
                if (t.length() > 3 && t.length() < 60) out.add(t.toLowerCase(Locale.ROOT));
            }
            if (p.getSkills() != null) {
                for (String s : p.getSkills()) {
                    if (out.size() >= 5) break;
                    if (s != null && !s.isBlank()) out.add(s.toLowerCase(Locale.ROOT).trim() + " developer");
                }
            }
        }
        if (out.isEmpty()) out.add("software engineer");
        return new ArrayList<>(out).subList(0, Math.min(5, out.size()));
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

    private static String matchedKeywords(String text, List<String> keywords) {
        String low = text.toLowerCase(Locale.ROOT);
        Set<String> hits = new LinkedHashSet<>();
        for (String kw : keywords) {
            String core = kw.replace(" developer", "").trim();
            if (!core.isEmpty() && low.contains(core)) hits.add(core);
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

    private static boolean isBlank(String s) { return s == null || s.isBlank(); }

    private static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
