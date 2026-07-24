package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.jsoup.Jsoup;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Workday (CXS) job boards. apply_type = ats.
 *
 * Workday has no public API and no shared host: every employer is its own tenant
 * ({@code nvidia.wd5.myworkdayjobs.com}), and jobs come from an undocumented endpoint that
 * must be POSTed to. Roughly a third of large enterprises hire through it (Microsoft, Adobe,
 * Salesforce, Cisco, Nvidia…), so it is worth the extra handling.
 *
 * The board token is simply the career-site URL, e.g.
 *   {@code https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite}
 * One value to seed and it can be pasted into a browser to confirm, which removes most of the
 * chance of a mis-registered board. Host, tenant and site are derived from it and used to build
 *   {@code POST https://{host}/wday/cxs/{tenant}/{site}/jobs}.
 *
 * Verified against live Nvidia / Adobe / Salesforce tenants before shipping. Two behaviours
 * that response confirmed and this relies on:
 *  - {@code total} is only meaningful on the first page (later pages report 0), so paging
 *    stops on a short page rather than trusting the count;
 *  - postings come back NEWEST FIRST, so once a page is entirely older than the freshness
 *    window there is nothing useful left and we stop early.
 */
@Component
public class WorkdayConnector implements JobConnector {

    /** Workday caps a page at 20 regardless of what we ask for. */
    private static final int PAGE = 20;
    /** Hard ceiling per board per run — a tenant can hold thousands of jobs. */
    private static final int MAX_PAGES = 6;
    /** Stop paging once everything on a page is older than this (a little over the 7-day gate). */
    private static final int STOP_AFTER_DAYS = 10;
    /** Ceiling on detail fetches per board per run, so one busy employer can't stall an ingest. */
    private static final int MAX_DETAILS = 60;

    private static final Pattern DAYS = Pattern.compile("(\\d+)\\s*\\+?\\s*days?\\s*ago", Pattern.CASE_INSENSITIVE);

    private final RestClient http;

    public WorkdayConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "workday";
    }

    @Override
    public boolean isPerBoard() {
        return true;
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        Site site = Site.parse(p.getBoardToken());
        if (site == null) throw new ConnectorException("workday: cannot read board token " + p.getBoardToken(), null);

        String endpoint = "https://" + site.host + "/wday/cxs/" + site.tenant + "/" + site.site + "/jobs";
        List<RawJob> out = new ArrayList<>();
        int details = 0;
        try {
            for (int page = 0; page < MAX_PAGES; page++) {
                String body = "{\"appliedFacets\":{},\"limit\":" + PAGE
                        + ",\"offset\":" + (page * PAGE) + ",\"searchText\":\"\"}";
                JsonNode root = http.post().uri(endpoint)
                        .contentType(MediaType.APPLICATION_JSON)
                        .accept(MediaType.APPLICATION_JSON)
                        .body(body)
                        .retrieve().body(JsonNode.class);
                if (root == null || !root.has("jobPostings")) break;
                JsonNode postings = root.get("jobPostings");
                if (postings.isEmpty()) break;

                boolean anyFresh = false;
                for (JsonNode j : postings) {
                    String title = j.path("title").asText(null);
                    String path = j.path("externalPath").asText(null);
                    if (title == null || path == null) continue;
                    Instant posted = parsePostedOn(j.path("postedOn").asText(null));
                    boolean fresh = posted == null
                            || posted.isAfter(Instant.now().minus(Duration.ofDays(STOP_AFTER_DAYS)));
                    if (fresh) anyFresh = true;

                    String description = null;
                    String employment = null;
                    // Open the posting for its body. The listing has no description at all, which
                    // left experience, employment type and the skills match unknowable for every
                    // Workday job — filtering on the title alone was guesswork. This is only
                    // affordable because the freshness window keeps the candidate set tiny: a
                    // board with thousands of jobs still only has a handful posted this week.
                    if (fresh && details < MAX_DETAILS) {
                        details++;
                        JsonNode d = detail(site, path);
                        if (d != null) {
                            String html = d.path("jobDescription").asText("");
                            if (!html.isBlank()) description = Jsoup.parse(html).text();
                            employment = blankToNull(d.path("timeType").asText(null));
                            // startDate is an exact date — far better than re-deriving one from
                            // "Posted Yesterday".
                            Instant exact = parseStartDate(d.path("startDate").asText(null));
                            if (exact != null) posted = exact;
                        }
                    }

                    out.add(RawJob.builder()
                            .source(source())
                            .sourceJobId(j.path("bulletFields").path(0).asText(path))
                            .title(title)
                            .company(p.getCompany() != null ? p.getCompany() : site.tenant)
                            .location(cleanLocation(j.path("locationsText").asText(null)))
                            .remote(isRemote(j.path("locationsText").asText("")))
                            // Employment type is stated outright by Workday, so prepend it rather
                            // than making the UI infer "Full time" from prose.
                            .description(employment == null ? description
                                    : (employment + ". " + (description == null ? "" : description)).trim())
                            .url("https://" + site.host + "/en-US/" + site.site + path)
                            .applyType("ats")
                            .postedAt(posted)
                            .build());
                }
                // Newest-first ordering: a page with nothing inside the window means the rest
                // is older still.
                if (!anyFresh) break;
                if (postings.size() < PAGE) break;  // short page = end of the board
            }
        } catch (Exception e) {
            throw new ConnectorException("workday fetch failed for " + site.tenant + "/" + site.site, e);
        }
        return out;
    }

    /**
     * One posting's full record: description, employment type and an exact start date.
     * The payload wraps everything in "jobPostingInfo" (confirmed against a live tenant), so
     * reading the root directly would silently yield empty fields.
     */
    private JsonNode detail(Site site, String externalPath) {
        try {
            JsonNode root = http.get()
                    .uri("https://" + site.host + "/wday/cxs/" + site.tenant + "/" + site.site + externalPath)
                    .accept(MediaType.APPLICATION_JSON)
                    .retrieve().body(JsonNode.class);
            if (root == null) return null;
            return root.has("jobPostingInfo") ? root.get("jobPostingInfo") : root;
        } catch (Exception e) {
            return null; // the listing data we already have is still worth keeping
        }
    }

    /** Workday's startDate is a plain yyyy-MM-dd. */
    static Instant parseStartDate(String s) {
        if (s == null || s.isBlank()) return null;
        try {
            return java.time.LocalDate.parse(s.substring(0, 10))
                    .atStartOfDay(java.time.ZoneOffset.UTC).toInstant();
        } catch (Exception e) {
            return null;
        }
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    /**
     * Workday reports age, not a date: "Posted Today", "Posted Yesterday", "Posted 5 Days Ago",
     * "Posted 30+ Days Ago". Without this the freshness window can't apply to Workday at all.
     */
    static Instant parsePostedOn(String s) {
        if (s == null || s.isBlank()) return null;
        String t = s.toLowerCase(Locale.ROOT);
        Instant now = Instant.now();
        if (t.contains("today") || t.contains("just posted")) return now;
        if (t.contains("yesterday")) return now.minus(Duration.ofDays(1));
        Matcher m = DAYS.matcher(t);
        if (m.find()) return now.minus(Duration.ofDays(Long.parseLong(m.group(1))));
        return null;
    }

    /** "4 Locations" is a roll-up, not a place — better to show nothing than something false. */
    static String cleanLocation(String s) {
        if (s == null || s.isBlank()) return null;
        return s.matches("(?i)\\d+\\s+locations?") ? null : s.trim();
    }

    static boolean isRemote(String locations) {
        return locations != null && locations.toLowerCase(Locale.ROOT).contains("remote");
    }

    /** host / tenant / site pulled out of a career-site URL. */
    public record Site(String host, String tenant, String site) {
        public static Site parse(String token) {
            if (token == null || token.isBlank()) return null;
            String t = token.trim().replaceFirst("^https?://", "");
            String[] parts = t.split("/");
            if (parts.length < 2) return null;
            String host = parts[0];
            // Drop a locale segment ("en-US") so both /en-US/Site and /Site work.
            List<String> segs = new ArrayList<>();
            for (int i = 1; i < parts.length; i++) {
                String seg = parts[i];
                if (seg.isBlank() || seg.matches("[a-z]{2}-[A-Z]{2}")) continue;
                segs.add(seg);
            }
            if (segs.isEmpty()) return null;
            String tenant = host.split("\\.")[0];
            return new Site(host, tenant, segs.get(segs.size() - 1));
        }
    }
}
