package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** Arbeitnow job-board API. Free, no key. apply_type = url. */
@Component
public class ArbeitnowConnector implements JobConnector {

    private final RestClient http;

    public ArbeitnowConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "arbeitnow";
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String url = "https://www.arbeitnow.com/api/job-board-api";
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url).retrieve().body(JsonNode.class);
            if (root == null || !root.has("data")) return out;
            for (JsonNode j : root.get("data")) {
                String html = j.path("description").asText("");
                Instant posted = j.has("created_at") ? Instant.ofEpochSecond(j.path("created_at").asLong()) : null;
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("slug").asText(null))
                        .title(j.path("title").asText())
                        .company(j.path("company_name").asText(null))
                        .location(j.path("location").asText(null))
                        .remote(j.path("remote").asBoolean(false))
                        .description(html.isBlank() ? "" : Jsoup.parse(html).text())
                        .url(j.path("url").asText())
                        .applyType("url")
                        .postedAt(posted)
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("arbeitnow fetch failed", e);
        }
        return out;
    }
}
