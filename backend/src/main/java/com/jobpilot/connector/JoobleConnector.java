package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Jooble search API. Free key, POSTed to {@code https://jooble.org/api/{key}}.
 *
 * <h2>Why this class did not exist until now</h2>
 *
 * {@code JobScoutService} has always looped looking for a connector whose {@code source()} is
 * {@code "jooble"} — and no such bean existed, so the branch was unreachable. The effect was
 * invisible in the worst way: the channel never even reported itself as unconfigured, because
 * the loop only ever sees beans that exist. {@code JOBPILOT_JOOBLE_KEY} sat in production
 * being read by nothing, and Scout ran on LinkedIn alone while its UI promised four sources.
 *
 * <h2>What Jooble actually returns</h2>
 *
 * Verified against the live API on 2026-09-19 with the production key:
 *
 * <pre>
 * { "totalCount": 23,
 *   "jobs": [ { title, location, snippet, salary, source, type, link, company, updated, id } ] }
 * </pre>
 *
 * Two properties of that payload drive the code below:
 *
 * <ol>
 *   <li>{@code link} is ALWAYS a {@code jooble.org/jdp/…} redirect, never the employer's own
 *       URL. Dedup by URL therefore works (the redirect is stable per listing), but no amount
 *       of host-parsing will reveal the real board.</li>
 *   <li>{@code source} is what names the real board — {@code decentrajobs.com},
 *       {@code jobs.dish.com}, {@code ceipal.com}. It is carried into {@code sourceJobId} so
 *       the caller can label a listing by where it genuinely came from instead of showing
 *       "jooble" for every row.</li>
 * </ol>
 *
 * The old Scout comment claimed Jooble "aggregates Naukri/Indeed/LinkedIn postings and
 * deep-links to the originals". That is false and the live response disproves it. This is a
 * volume source with an honest origin label, and nothing more.
 */
@Component
public class JoobleConnector implements JobConnector {

    /** Jooble's `updated` is a local-time ISO stamp with no zone marker: 2026-09-04T00:00:00.0000000 */
    private static final int MAX_FRACTION_DIGITS = 9;

    private final RestClient http;
    private final JobPilotProperties props;

    public JoobleConnector(RestClient http, JobPilotProperties props) {
        this.http = http;
        this.props = props;
    }

    @Override
    public String source() {
        return "jooble";
    }

    @Override
    public boolean isConfigured() {
        return notBlank(props.getJooble().getKey());
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        JobPilotProperties.Jooble cfg = props.getJooble();
        String keywords = p.getQuery() == null || p.getQuery().isBlank() ? "software engineer" : p.getQuery();
        String where = p.getWhere() != null ? p.getWhere() : cfg.getWhere();

        List<RawJob> out = new ArrayList<>();
        try {
            // The key is a PATH segment, not a header or a query parameter. Passing it by
            // URI-template placeholder keeps it out of any logged URL string we build.
            JsonNode root = http.post()
                    .uri("https://jooble.org/api/{key}", cfg.getKey())
                    .header("Content-Type", "application/json")
                    .body(Map.of("keywords", keywords, "location", where))
                    .retrieve().body(JsonNode.class);
            if (root == null || !root.has("jobs")) return out;

            for (JsonNode j : root.get("jobs")) {
                String link = j.path("link").asText(null);
                String title = j.path("title").asText(null);
                if (link == null || link.isBlank() || title == null || title.isBlank()) continue;

                // Snippets arrive as HTML: &nbsp; entities and <b> around the matched term.
                String snippet = j.path("snippet").asText("");
                out.add(RawJob.builder()
                        .source(source())
                        // The real board, for callers that want to label the origin rather
                        // than say "jooble" for every listing.
                        .sourceJobId(emptyToNull(j.path("source").asText(null)))
                        .title(title.trim())
                        .company(emptyToNull(j.path("company").asText(null)))
                        .location(emptyToNull(j.path("location").asText(null)))
                        .description(snippet.isBlank() ? "" : Jsoup.parse(snippet).text())
                        .url(link.trim())
                        .applyType("url")
                        .salaryText(emptyToNull(j.path("salary").asText(null)))
                        .postedAt(parseUpdated(j.path("updated").asText(null)))
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("jooble fetch failed for query '" + keywords + "'", e);
        }
        return out;
    }

    /**
     * {@code 2026-09-04T00:00:00.0000000} — ISO local date-time, no zone, and a 7-digit
     * fraction that {@link LocalDateTime#parse} accepts only up to 9. Treated as UTC: Jooble
     * does not say otherwise, and the value is only ever used for freshness ordering.
     * An unparseable stamp yields null rather than throwing away the whole listing.
     */
    static Instant parseUpdated(String s) {
        if (s == null || s.isBlank()) return null;
        try {
            String v = s.trim();
            int dot = v.indexOf('.');
            if (dot >= 0 && v.length() - dot - 1 > MAX_FRACTION_DIGITS) {
                v = v.substring(0, dot + 1 + MAX_FRACTION_DIGITS);
            }
            return LocalDateTime.parse(v).toInstant(java.time.ZoneOffset.UTC);
        } catch (Exception e) {
            return null;
        }
    }

    private static String emptyToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
