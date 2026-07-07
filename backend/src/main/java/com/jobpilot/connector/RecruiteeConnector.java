package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

/** Public Recruitee careers-site API (keyless). apply_type = ats. */
@Component
public class RecruiteeConnector implements JobConnector {

    private final RestClient http;

    public RecruiteeConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "recruitee";
    }

    @Override
    public boolean isPerBoard() {
        return true;
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String token = p.getBoardToken();
        String url = "https://" + token + ".recruitee.com/api/offers/";
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url).retrieve().body(JsonNode.class);
            if (root == null || !root.has("offers")) return out;
            for (JsonNode j : root.get("offers")) {
                String city = j.path("city").asText("");
                String country = j.path("country").asText("");
                String location = (city + (country.isBlank() ? "" : (city.isBlank() ? "" : ", ") + country)).trim();
                String remoteFlag = j.path("remote").asText("");
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("id").asText(null))
                        .title(j.path("title").asText())
                        .company(p.getCompany())
                        .location(location.isBlank() ? null : location)
                        .remote("true".equalsIgnoreCase(remoteFlag) || location.toLowerCase().contains("remote"))
                        .description("")
                        .url(j.path("careers_url").asText("https://" + token + ".recruitee.com/"))
                        .applyType("ats")
                        .postedAt(parse(j.path("published_at").asText(j.path("created_at").asText(null))))
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("recruitee fetch failed for board " + token, e);
        }
        return out;
    }

    /** Recruitee timestamps look like "2024-05-01 10:20:30 UTC" or ISO offsets. */
    private static Instant parse(String s) {
        if (s == null || s.isBlank()) return null;
        try {
            return Instant.parse(s);
        } catch (Exception ignored) { /* try next format */ }
        try {
            return OffsetDateTime.parse(s).toInstant();
        } catch (Exception ignored) { /* try next format */ }
        try {
            return Instant.parse(s.replace(" UTC", "Z").replace(" ", "T"));
        } catch (Exception e) {
            return null;
        }
    }
}
