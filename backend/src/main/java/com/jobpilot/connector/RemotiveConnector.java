package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** Remotive remote-jobs API. Free, no key. apply_type = url. */
@Component
public class RemotiveConnector implements JobConnector {

    private final RestClient http;

    public RemotiveConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "remotive";
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String url = "https://remotive.com/api/remote-jobs?category=software-dev&limit=60";
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url).retrieve().body(JsonNode.class);
            if (root == null || !root.has("jobs")) return out;
            for (JsonNode j : root.get("jobs")) {
                String html = j.path("description").asText("");
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("id").asText(null))
                        .title(j.path("title").asText())
                        .company(j.path("company_name").asText(null))
                        .location(j.path("candidate_required_location").asText("Remote"))
                        .remote(true)
                        .description(html.isBlank() ? "" : Jsoup.parse(html).text())
                        .url(j.path("url").asText())
                        .applyType("url")
                        .salaryText(emptyToNull(j.path("salary").asText(null)))
                        .postedAt(parse(j.path("publication_date").asText(null)))
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("remotive fetch failed", e);
        }
        return out;
    }

    private static String emptyToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }

    private static Instant parse(String s) {
        try {
            if (s == null || s.isBlank()) return null;
            return Instant.parse(s.endsWith("Z") ? s : s.replace(" ", "T") + "Z");
        } catch (Exception e) {
            return null;
        }
    }
}
