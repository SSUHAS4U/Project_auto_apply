package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** Public Lever postings JSON. apply_type = ats. */
@Component
public class LeverConnector implements JobConnector {

    private final RestClient http;

    public LeverConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "lever";
    }

    @Override
    public boolean isPerBoard() {
        return true;
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String company = p.getBoardToken();
        String url = "https://api.lever.co/v0/postings/" + company + "?mode=json";
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode arr = http.get().uri(url).retrieve().body(JsonNode.class);
            if (arr == null || !arr.isArray()) return out;
            for (JsonNode j : arr) {
                String html = j.path("descriptionPlain").asText(j.path("description").asText(""));
                String desc = html.isBlank() ? "" : Jsoup.parse(html).text();
                String location = j.path("categories").path("location").asText(null);
                Instant posted = j.has("createdAt") ? Instant.ofEpochMilli(j.path("createdAt").asLong()) : null;
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("id").asText(null))
                        .title(j.path("text").asText())
                        .company(p.getCompany())
                        .location(location)
                        .remote(j.path("workplaceType").asText("").equalsIgnoreCase("remote")
                                || (location != null && location.toLowerCase().contains("remote")))
                        .description(desc)
                        .url(j.path("hostedUrl").asText(j.path("applyUrl").asText()))
                        .applyType("ats")
                        .postedAt(posted)
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("lever fetch failed for " + company, e);
        }
        return out;
    }
}
