package com.jobpilot.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.AtsSource;
import com.jobpilot.domain.Profile;
import com.jobpilot.repository.AtsSourceRepository;
import com.jobpilot.repository.ProfileRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The self-growing job-source ecosystem. Runs daily (see DailyScheduler) and:
 *
 *  1. HEALTH-CHECKS every active board in {@code ats_source} against its public
 *     ATS API — records job counts, and deactivates boards that fail repeatedly
 *     (company left the ATS, token renamed, board closed).
 *  2. REVIVES inactive boards that respond again with live jobs.
 *  3. DISCOVERS new boards two ways:
 *       - probing a curated candidate list of company tokens against the free
 *         Greenhouse / Lever / Ashby public APIs (no key, no scraping);
 *       - if Google CSE keys are set, searching the public job-board domains for
 *         freshly indexed postings that match the profile's skills, and pulling
 *         the board tokens out of the result URLs.
 *     Every candidate is verified live (must return > 0 jobs) before insertion,
 *     so only working, recently-updated boards enter the ingest rotation.
 */
@Service
public class AtsDiscoveryService {

    private static final Logger log = LoggerFactory.getLogger(AtsDiscoveryService.class);

    /** A board is deactivated after this many consecutive failed probes. */
    private static final int MAX_FAILS = 3;

    private final AtsSourceRepository atsRepo;
    private final ProfileRepository profileRepo;
    private final RestClient http;
    private final JobPilotProperties props;

    public AtsDiscoveryService(AtsSourceRepository atsRepo, ProfileRepository profileRepo,
                               RestClient http, JobPilotProperties props) {
        this.atsRepo = atsRepo;
        this.profileRepo = profileRepo;
        this.http = http;
        this.props = props;
    }

    /**
     * Candidate company tokens to probe. Wrong guesses cost one cheap 404 and are
     * skipped — only tokens whose board answers with live jobs are added. Skewed
     * to India-hiring and remote-friendly product companies.
     */
    private static final String[][] CANDIDATES = {
            // provider, token, display name
            {"greenhouse", "razorpay", "Razorpay"},
            {"greenhouse", "rippling", "Rippling"},
            {"greenhouse", "chargebee", "Chargebee"},
            {"greenhouse", "browserstack", "BrowserStack"},
            {"greenhouse", "freshworks", "Freshworks"},
            {"greenhouse", "zenoti", "Zenoti"},
            {"greenhouse", "innovaccer", "Innovaccer"},
            {"greenhouse", "sprinklr", "Sprinklr"},
            {"greenhouse", "uniphore", "Uniphore"},
            {"greenhouse", "whatfix", "Whatfix"},
            {"greenhouse", "hasura", "Hasura"},
            {"greenhouse", "cleartax", "ClearTax"},
            {"greenhouse", "juspay", "Juspay"},
            {"greenhouse", "atlan", "Atlan"},
            {"greenhouse", "hackerrank", "HackerRank"},
            {"greenhouse", "netradyne", "Netradyne"},
            {"greenhouse", "salesken", "Salesken"},
            {"greenhouse", "airmeet", "Airmeet"},
            {"greenhouse", "grafana", "Grafana Labs"},
            {"greenhouse", "digitalocean", "DigitalOcean"},
            {"greenhouse", "andela", "Andela"},
            {"greenhouse", "turing", "Turing"},
            {"lever", "razorpay", "Razorpay"},
            {"lever", "dunzo", "Dunzo"},
            {"lever", "upstox", "Upstox"},
            {"lever", "groww", "Groww"},
            {"lever", "khatabook", "Khatabook"},
            {"lever", "slintel", "Slintel"},
            {"lever", "netomi", "Netomi"},
            {"lever", "yellow-ai", "Yellow.ai"},
            {"lever", "hevo", "Hevo Data"},
            {"lever", "postman", "Postman"},
            {"ashby", "zepto", "Zepto"},
            {"ashby", "cred", "CRED"},
            {"ashby", "rubrik", "Rubrik"},
            {"ashby", "sardine", "Sardine"},
            {"ashby", "multiplier", "Multiplier"},
            {"ashby", "docker", "Docker"},
            {"ashby", "deel", "Deel"},
            {"ashby", "commure", "Commure"},
    };

    /** Full daily run: health-check existing boards, then discover new ones. */
    public Map<String, Object> discover() {
        Map<String, Object> summary = new LinkedHashMap<>();
        int checked = 0, deactivated = 0, revived = 0, added = 0;

        // 1. Health pass over everything we know about.
        for (AtsSource src : atsRepo.findAll()) {
            Integer count = probe(src.getProvider(), src.getBoardToken());
            src.setLastCheckedAt(Instant.now());
            if (count == null) {
                src.setFailCount(src.getFailCount() + 1);
                if (src.isActive() && src.getFailCount() >= MAX_FAILS) {
                    src.setActive(false);
                    deactivated++;
                    log.info("Discovery: deactivated dead board {}/{} ({} consecutive failures)",
                            src.getProvider(), src.getBoardToken(), src.getFailCount());
                }
            } else {
                src.setFailCount(0);
                src.setLastJobCount(count);
                if (!src.isActive() && count > 0) {
                    src.setActive(true);
                    revived++;
                    log.info("Discovery: revived board {}/{} ({} live jobs)",
                            src.getProvider(), src.getBoardToken(), count);
                }
            }
            atsRepo.save(src);
            checked++;
        }

        // 2. Probe the curated candidate list for boards we don't have yet.
        for (String[] c : CANDIDATES) {
            if (addIfLive(c[0], c[1], c[2], "probe")) added++;
        }

        // 3. Google CSE: find freshly indexed board URLs matching the profile.
        for (String[] found : cseCandidates()) {
            if (addIfLive(found[0], found[1], found[2], "google-cse")) added++;
        }

        summary.put("checked", checked);
        summary.put("deactivated", deactivated);
        summary.put("revived", revived);
        summary.put("added", added);
        summary.put("activeBoards", atsRepo.findByActiveTrue().size());
        log.info("Discovery complete: {}", summary);
        return summary;
    }

    /** Verify a candidate board live and insert it if it has jobs. @return true if added. */
    private boolean addIfLive(String provider, String token, String company, String via) {
        token = token.toLowerCase(Locale.ROOT).trim();
        if (token.isEmpty() || atsRepo.findByProviderAndBoardToken(provider, token).isPresent()) return false;
        Integer count = probe(provider, token);
        if (count == null || count == 0) return false;
        AtsSource src = new AtsSource();
        src.setProvider(provider);
        src.setBoardToken(token);
        src.setCompany(company == null || company.isBlank() ? prettify(token) : company);
        src.setActive(true);
        src.setDiscoveredVia(via);
        src.setLastCheckedAt(Instant.now());
        src.setLastJobCount(count);
        try {
            atsRepo.save(src);
        } catch (org.springframework.dao.DataIntegrityViolationException dup) {
            return false; // raced with another run
        }
        log.info("Discovery: added new board {}/{} via {} ({} live jobs)", provider, token, via, count);
        return true;
    }

    /**
     * Probe a board's public API. @return the number of open jobs, or null if the
     * board doesn't exist / errored (404, network, malformed).
     */
    Integer probe(String provider, String token) {
        try {
            switch (provider) {
                case "greenhouse": {
                    JsonNode r = http.get()
                            .uri("https://boards-api.greenhouse.io/v1/boards/{t}/jobs", token)
                            .retrieve().body(JsonNode.class);
                    return r == null ? null : r.path("jobs").size();
                }
                case "lever": {
                    JsonNode r = http.get()
                            .uri("https://api.lever.co/v0/postings/{t}?mode=json", token)
                            .retrieve().body(JsonNode.class);
                    return r == null || !r.isArray() ? null : r.size();
                }
                case "ashby": {
                    JsonNode r = http.get()
                            .uri("https://api.ashbyhq.com/posting-api/job-board/{t}", token)
                            .retrieve().body(JsonNode.class);
                    return r == null ? null : r.path("jobs").size();
                }
                default:
                    return null;
            }
        } catch (Exception e) {
            return null;
        }
    }

    // ---- Google CSE token mining ---------------------------------------------

    private static final Pattern GREENHOUSE_URL = Pattern.compile("boards\\.greenhouse\\.io/([a-z0-9-]+)");
    private static final Pattern LEVER_URL = Pattern.compile("jobs\\.lever\\.co/([a-zA-Z0-9-]+)");
    private static final Pattern ASHBY_URL = Pattern.compile("jobs\\.ashbyhq\\.com/([a-zA-Z0-9-]+)");

    /**
     * Search each board domain for postings recently indexed by Google that match
     * the candidate's top skills, and extract board tokens from result links.
     * Silently returns nothing when CSE keys aren't configured.
     */
    private List<String[]> cseCandidates() {
        JobPilotProperties.GoogleCse g = props.getGoogleCse();
        List<String[]> out = new ArrayList<>();
        if (g.getApiKey() == null || g.getApiKey().isBlank()
                || g.getCx() == null || g.getCx().isBlank()) return out;

        String skills = topSkills();
        String[][] sites = {
                {"greenhouse", "boards.greenhouse.io"},
                {"lever", "jobs.lever.co"},
                {"ashby", "jobs.ashbyhq.com"},
        };
        Set<String> seen = new LinkedHashSet<>();
        for (String[] site : sites) {
            String q = "site:" + site[1] + " " + skills;
            try {
                JsonNode root = http.get().uri(uri -> uri
                                .scheme("https").host("customsearch.googleapis.com").path("/customsearch/v1")
                                .queryParam("key", g.getApiKey())
                                .queryParam("cx", g.getCx())
                                .queryParam("q", q)
                                .queryParam("num", 10)
                                .queryParam("dateRestrict", "d7")
                                .build())
                        .retrieve().body(JsonNode.class);
                if (root == null || !root.has("items")) continue;
                Pattern p = switch (site[0]) {
                    case "greenhouse" -> GREENHOUSE_URL;
                    case "lever" -> LEVER_URL;
                    default -> ASHBY_URL;
                };
                for (JsonNode it : root.get("items")) {
                    Matcher m = p.matcher(it.path("link").asText(""));
                    if (m.find()) {
                        String token = m.group(1).toLowerCase(Locale.ROOT);
                        if (seen.add(site[0] + "/" + token)) {
                            out.add(new String[]{site[0], token, prettify(token)});
                        }
                    }
                }
            } catch (Exception e) {
                log.debug("Discovery CSE query failed for {}: {}", site[1], e.getMessage());
            }
        }
        return out;
    }

    /** The candidate's first few skills as a search phrase, else a sensible default. */
    private String topSkills() {
        Optional<Profile> p = profileRepo.findFirstByOrderByUpdatedAtAsc();
        if (p.isPresent() && p.get().getSkills() != null && !p.get().getSkills().isEmpty()) {
            List<String> s = p.get().getSkills();
            return String.join(" ", s.subList(0, Math.min(3, s.size()))) + " engineer";
        }
        return "software engineer";
    }

    private static String prettify(String token) {
        String[] parts = token.replace('-', ' ').split(" ");
        StringBuilder sb = new StringBuilder();
        for (String w : parts) {
            if (w.isEmpty()) continue;
            sb.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1)).append(' ');
        }
        return sb.toString().trim();
    }
}
