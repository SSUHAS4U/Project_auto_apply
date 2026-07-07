package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

/** Public Workable job-widget API (keyless). apply_type = ats. */
@Component
public class WorkableConnector implements JobConnector {

    private final RestClient http;

    public WorkableConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "workable";
    }

    @Override
    public boolean isPerBoard() {
        return true;
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String token = p.getBoardToken();
        String url = "https://apply.workable.com/api/v1/widget/accounts/" + token;
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url).retrieve().body(JsonNode.class);
            if (root == null || !root.has("jobs")) return out;
            for (JsonNode j : root.get("jobs")) {
                String city = j.path("city").asText("");
                String country = j.path("country").asText("");
                String location = (city + (country.isBlank() ? "" : (city.isBlank() ? "" : ", ") + country)).trim();
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("shortcode").asText(null))
                        .title(j.path("title").asText())
                        .company(p.getCompany())
                        .location(location.isBlank() ? null : location)
                        .remote(j.path("telecommuting").asBoolean(false))
                        .description("")
                        .url(j.path("url").asText("https://apply.workable.com/" + token + "/"))
                        .applyType("ats")
                        .postedAt(parse(j.path("published_on").asText(null)))
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("workable fetch failed for board " + token, e);
        }
        return out;
    }

    /** Workable dates are plain YYYY-MM-DD. */
    private static Instant parse(String date) {
        try {
            return date == null ? null : LocalDate.parse(date).atStartOfDay(ZoneOffset.UTC).toInstant();
        } catch (Exception e) {
            return null;
        }
    }
}
