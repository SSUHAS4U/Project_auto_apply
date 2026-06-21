package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** RemoteOK API. Free, no key (first array element is a legal notice). apply_type = url. */
@Component
public class RemoteOkConnector implements JobConnector {

    private final RestClient http;

    public RemoteOkConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "remoteok";
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String url = "https://remoteok.com/api";
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode arr = http.get().uri(url).retrieve().body(JsonNode.class);
            if (arr == null || !arr.isArray()) return out;
            for (JsonNode j : arr) {
                // Skip the legal-notice object and anything without a position.
                if (!j.has("position") && !j.has("title")) continue;
                String html = j.path("description").asText("");
                String title = j.path("position").asText(j.path("title").asText(""));
                if (title.isBlank()) continue;
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("id").asText(null))
                        .title(title)
                        .company(j.path("company").asText(null))
                        .location(j.path("location").asText("Remote"))
                        .remote(true)
                        .description(html.isBlank() ? "" : Jsoup.parse(html).text())
                        .url(j.path("url").asText())
                        .applyType("url")
                        .salaryText(salary(j))
                        .postedAt(parse(j.path("date").asText(null)))
                        .build());
                if (out.size() >= 60) break;
            }
        } catch (Exception e) {
            throw new ConnectorException("remoteok fetch failed", e);
        }
        return out;
    }

    private static String salary(JsonNode j) {
        long min = j.path("salary_min").asLong(0);
        long max = j.path("salary_max").asLong(0);
        return (min > 0 || max > 0) ? min + " - " + max : null;
    }

    private static Instant parse(String s) {
        try {
            return s == null || s.isBlank() ? null : Instant.parse(s);
        } catch (Exception e) {
            return null;
        }
    }
}
