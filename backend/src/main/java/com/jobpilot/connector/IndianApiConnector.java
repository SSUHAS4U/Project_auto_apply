package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * IndianAPI.in jobs feed — India-focused aggregator. Needs an x-api-key (register at
 * indianapi.in). The schema isn't publicly documented, so field names are read defensively.
 */
@Component
public class IndianApiConnector implements JobConnector {

    private final RestClient http;
    private final JobPilotProperties props;

    public IndianApiConnector(RestClient http, JobPilotProperties props) {
        this.http = http;
        this.props = props;
    }

    @Override
    public String source() {
        return "indianapi";
    }

    @Override
    public boolean isConfigured() {
        return notBlank(props.getIndianApi().getApiKey());
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        JobPilotProperties.IndianApi cfg = props.getIndianApi();
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(cfg.getUrl())
                    .header("accept", "application/json")
                    .header("x-api-key", cfg.getApiKey())
                    .retrieve().body(JsonNode.class);
            JsonNode arr = firstArray(root);
            if (arr == null) return out;
            for (JsonNode j : arr) {
                String title = text(j, "title", "job_title", "position", "role", "name");
                String url = text(j, "url", "apply_link", "applyUrl", "link", "job_url", "redirect_url");
                if (title.isBlank() || url.isBlank()) continue;
                String desc = text(j, "description", "job_description", "details");
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(text(j, "id", "job_id", "_id"))
                        .title(title)
                        .company(emptyToNull(text(j, "company", "company_name", "employer", "organization")))
                        .location(emptyToNull(text(j, "location", "city", "job_location", "place")))
                        .description(desc.isBlank() ? "" : Jsoup.parse(desc).text())
                        .url(url)
                        .applyType("url")
                        .salaryText(emptyToNull(text(j, "salary", "salary_range", "ctc")))
                        .postedAt(parse(text(j, "posted_at", "date", "published_at", "created_at")))
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("indianapi fetch failed", e);
        }
        return out;
    }

    /** Locate the job array whether the body is an array or wrapped under a common key. */
    private static JsonNode firstArray(JsonNode root) {
        if (root == null) return null;
        if (root.isArray()) return root;
        for (String k : new String[]{"jobs", "results", "data", "items", "postings"}) {
            if (root.has(k) && root.get(k).isArray()) return root.get(k);
        }
        return null;
    }

    private static String text(JsonNode n, String... keys) {
        for (String k : keys) {
            JsonNode v = n.get(k);
            if (v != null && !v.isNull() && !v.asText("").isBlank()) return v.asText();
        }
        return "";
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

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
