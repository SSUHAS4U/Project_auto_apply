package com.jobpilot.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * /scrape — the engine's own portal search, clean-room replica of the repo's
 * linkedin-search skill: LinkedIn's public unauthenticated jobs-guest endpoints,
 * every keyword × every location, deduped into the engine's seen-store.
 *
 * Like the repo warns: personal use only, keep volume low — we fetch at most
 * 2 pages (50 results) per query with a polite delay between requests.
 */
@Service
public class EngineScraperService {

    private static final Logger log = LoggerFactory.getLogger(EngineScraperService.class);

    private static final String GUEST_SEARCH =
            "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=%s&location=%s&start=%d";
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
    private static final int PAGES_PER_QUERY = 2;   // 25 results/page
    private static final long DELAY_MS = 1600;

    private final EngineJobRepository jobs;
    private final EngineSetupService setup;
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    /** Per-user progress line + running flag so the dashboard can watch a scrape. */
    private final Map<UUID, String> progress = new ConcurrentHashMap<>();
    private final Map<UUID, AtomicBoolean> running = new ConcurrentHashMap<>();

    public EngineScraperService(EngineJobRepository jobs, EngineSetupService setup) {
        this.jobs = jobs;
        this.setup = setup;
    }

    public String progress(UUID userId) { return progress.getOrDefault(userId, ""); }
    public boolean isRunning(UUID userId) {
        return running.computeIfAbsent(userId, k -> new AtomicBoolean(false)).get();
    }

    /** Run a full scrape from the profile's search queries. Returns a summary. */
    public Map<String, Object> run(UUID userId) {
        AtomicBoolean flag = running.computeIfAbsent(userId, k -> new AtomicBoolean(false));
        if (!flag.compareAndSet(false, true)) throw new IllegalStateException("A scrape is already running.");
        try {
            Queries q = queries(userId);
            int found = 0, added = 0, dup = 0;
            List<String> errors = new ArrayList<>();
            for (String kw : q.keywords()) {
                for (String loc : q.locations()) {
                    progress.put(userId, "Searching \"" + kw + "\" in " + loc + "…");
                    for (int page = 0; page < PAGES_PER_QUERY; page++) {
                        try {
                            List<EngineJob> batch = searchPage(kw, loc, page * 25);
                            if (batch.isEmpty()) break;
                            found += batch.size();
                            for (EngineJob j : batch) {
                                j.setUserId(userId);
                                if (jobs.existsByUserIdAndContentHash(userId, j.getContentHash())) { dup++; continue; }
                                jobs.save(j);
                                added++;
                            }
                            Thread.sleep(DELAY_MS);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            break;
                        } catch (Exception e) {
                            errors.add(kw + "@" + loc + ": " + e.getMessage());
                            log.warn("scrape page failed ({} @ {}): {}", kw, loc, e.getMessage());
                            break; // don't hammer a failing query
                        }
                    }
                }
            }
            progress.put(userId, "");
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("keywords", q.keywords());
            out.put("locations", q.locations());
            out.put("found", found);
            out.put("added", added);
            out.put("duplicates", dup);
            if (!errors.isEmpty()) out.put("errors", errors.subList(0, Math.min(3, errors.size())));
            return out;
        } finally {
            flag.set(false);
            progress.put(userId, "");
        }
    }

    /** One guest-endpoint page: an HTML fragment of <li> job cards. */
    List<EngineJob> searchPage(String keywords, String location, int start) throws Exception {
        String url = String.format(GUEST_SEARCH, enc(keywords), enc(location), start);
        String html = get(url);
        List<EngineJob> out = new ArrayList<>();
        Document doc = Jsoup.parse(html);
        for (Element card : doc.select("li")) {
            String title = text(card, ".base-search-card__title, h3");
            String company = text(card, ".base-search-card__subtitle, h4");
            String loc = text(card, ".job-search-card__location");
            Element a = card.selectFirst("a.base-card__full-link, a[href*=/jobs/view/]");
            String href = a != null ? a.attr("href") : "";
            if (title.isBlank() || href.isBlank()) continue;
            EngineJob j = new EngineJob();
            j.setSource("linkedin");
            j.setTitle(title);
            j.setCompany(company);
            j.setLocation(loc.isBlank() ? location : loc);
            j.setUrl(href.split("\\?")[0]);
            j.setExternalId(extractId(href));
            Element time = card.selectFirst("time");
            j.setPostedAt(time != null
                    ? (time.hasAttr("datetime") ? time.attr("datetime") : time.text())
                    : null);
            j.setContentHash(hash(title, company, j.getLocation()));
            out.add(j);
        }
        return out;
    }

    /** Fetch a posting's full description from the guest job page (used by rank/apply). */
    public String fetchDescription(String jobUrl) {
        try {
            String html = get(jobUrl);
            Document doc = Jsoup.parse(html);
            Element d = doc.selectFirst(".show-more-less-html__markup, .description__text, #job-details");
            if (d != null) return d.text();
            // JSON-LD fallback
            for (Element s : doc.select("script[type=application/ld+json]")) {
                try {
                    JsonNode n = mapper.readTree(s.data());
                    if (n.has("description")) return Jsoup.parse(n.get("description").asText()).text();
                } catch (Exception ignore) { /* try next block */ }
            }
            return "";
        } catch (Exception e) {
            log.debug("description fetch failed for {}: {}", jobUrl, e.getMessage());
            return "";
        }
    }

    /** Expired check: the guest page shows a closed notice or the posting 404s. */
    public boolean isExpired(String jobUrl) {
        try {
            String html = get(jobUrl);
            String low = html.toLowerCase(Locale.ROOT);
            return low.contains("no longer accepting applications") || low.contains("job is closed");
        } catch (Exception e) {
            String m = e.getMessage() == null ? "" : e.getMessage();
            return m.contains("404") || m.contains("410");
        }
    }

    // ---- helpers -------------------------------------------------------------

    record Queries(List<String> keywords, List<String> locations) {}

    Queries queries(UUID userId) {
        try {
            JsonNode n = mapper.readTree(setup.get(userId).getSearchQueries());
            List<String> kw = new ArrayList<>(), loc = new ArrayList<>();
            n.path("keywords").forEach(x -> kw.add(x.asText()));
            n.path("locations").forEach(x -> loc.add(x.asText()));
            if (kw.isEmpty() || loc.isEmpty()) throw new IllegalStateException("empty");
            return new Queries(kw.stream().limit(5).toList(), loc.stream().limit(4).toList());
        } catch (Exception e) {
            throw new IllegalStateException("Search queries missing — run Setup first.");
        }
    }

    private String get(String url) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                .header("User-Agent", UA)
                .header("Accept-Language", "en-US,en;q=0.9")
                .timeout(Duration.ofSeconds(20))
                .GET().build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() >= 400) throw new IllegalStateException("HTTP " + res.statusCode());
        return res.body();
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }

    private static String text(Element root, String sel) {
        Element e = root.selectFirst(sel);
        return e == null ? "" : e.text().trim();
    }

    private static String extractId(String href) {
        var m = java.util.regex.Pattern.compile("-(\\d{6,})(?:\\?|$)").matcher(href);
        return m.find() ? m.group(1) : null;
    }

    static String hash(String title, String company, String location) {
        try {
            String key = (nz(title) + "|" + nz(company) + "|" + nz(location)).toLowerCase(Locale.ROOT);
            byte[] d = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String nz(String s) { return s == null ? "" : s.trim(); }
}
