package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

/** Jobicy remote-jobs API v2. Free, no key. apply_type = url. */
@Component
public class JobicyConnector implements JobConnector {

    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final RestClient http;

    public JobicyConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "jobicy";
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String url = "https://jobicy.com/api/v2/remote-jobs?count=50";
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url).retrieve().body(JsonNode.class);
            if (root == null || !root.has("jobs")) return out;
            for (JsonNode j : root.get("jobs")) {
                String html = j.path("jobDescription").asText(j.path("jobExcerpt").asText(""));
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("id").asText(null))
                        .title(j.path("jobTitle").asText())
                        .company(j.path("companyName").asText(null))
                        .location(j.path("jobGeo").asText("Remote"))
                        .remote(true)
                        .description(html.isBlank() ? "" : Jsoup.parse(html).text())
                        .url(j.path("url").asText())
                        .applyType("url")
                        .postedAt(parse(j.path("pubDate").asText(null)))
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("jobicy fetch failed", e);
        }
        return out;
    }

    private static Instant parse(String s) {
        try {
            if (s == null || s.isBlank()) return null;
            return LocalDateTime.parse(s, FMT).toInstant(ZoneOffset.UTC);
        } catch (Exception e) {
            return null;
        }
    }
}
