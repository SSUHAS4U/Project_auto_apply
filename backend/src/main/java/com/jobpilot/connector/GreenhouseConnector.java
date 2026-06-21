package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** Public Greenhouse boards JSON. apply_type = ats. */
@Component
public class GreenhouseConnector implements JobConnector {

    private final RestClient http;

    public GreenhouseConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "greenhouse";
    }

    @Override
    public boolean isPerBoard() {
        return true;
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String token = p.getBoardToken();
        // No content=true: descriptions can be MBs each (memory blow-up on small heaps).
        // The list/scoring works off the title; descriptions aren't needed for ATS jobs.
        String url = "https://boards-api.greenhouse.io/v1/boards/" + token + "/jobs";
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url).retrieve().body(JsonNode.class);
            if (root == null || !root.has("jobs")) return out;
            for (JsonNode j : root.get("jobs")) {
                String location = j.path("location").path("name").asText(null);
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("id").asText(null))
                        .title(j.path("title").asText())
                        .company(p.getCompany())
                        .location(location)
                        .remote(location != null && location.toLowerCase().contains("remote"))
                        .description("")
                        .url(j.path("absolute_url").asText())
                        .applyType("ats")
                        .postedAt(parse(j.path("updated_at").asText(null)))
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("greenhouse fetch failed for board " + token, e);
        }
        return out;
    }

    private static Instant parse(String iso) {
        try {
            return iso == null ? null : Instant.parse(iso);
        } catch (Exception e) {
            return null;
        }
    }
}
