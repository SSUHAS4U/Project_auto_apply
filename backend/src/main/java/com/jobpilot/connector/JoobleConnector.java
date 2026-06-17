package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.jsoup.Jsoup;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Jooble aggregator API (POST with key in path). apply_type = url. */
@Component
public class JoobleConnector implements JobConnector {

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
        String k = props.getJooble().getKey();
        return k != null && !k.isBlank();
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String key = props.getJooble().getKey();
        String url = "https://jooble.org/api/" + key;
        String keywords = p.getQuery() != null ? p.getQuery() : props.getJooble().getKeywords();
        Map<String, Object> body = Map.of(
                "keywords", keywords,
                "location", p.getWhere() != null ? p.getWhere() : "");

        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.post().uri(url)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve().body(JsonNode.class);
            if (root == null || !root.has("jobs")) return out;
            for (JsonNode j : root.get("jobs")) {
                String snippet = j.path("snippet").asText("");
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("id").asText(null))
                        .title(j.path("title").asText())
                        .company(j.path("company").asText(null))
                        .location(j.path("location").asText(null))
                        .description(Jsoup.parse(snippet).text())
                        .url(j.path("link").asText())
                        .applyType("url")
                        .salaryText(emptyToNull(j.path("salary").asText(null)))
                        .postedAt(parseDate(j.path("updated").asText(null)))
                        .raw(j.toString())
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("jooble fetch failed for '" + keywords + "'", e);
        }
        return out;
    }

    private static String emptyToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }

    private static Instant parseDate(String s) {
        try {
            if (s == null || s.isBlank()) return null;
            // Jooble returns ISO-ish timestamps; fall back to date-only.
            try {
                return Instant.parse(s);
            } catch (Exception ignored) {
                return LocalDate.parse(s.substring(0, 10)).atStartOfDay(java.time.ZoneOffset.UTC).toInstant();
            }
        } catch (Exception e) {
            return null;
        }
    }
}
