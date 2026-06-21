package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** Adzuna search API (covers India). apply_type = url. */
@Component
public class AdzunaConnector implements JobConnector {

    private final RestClient http;
    private final JobPilotProperties props;

    public AdzunaConnector(RestClient http, JobPilotProperties props) {
        this.http = http;
        this.props = props;
    }

    @Override
    public String source() {
        return "adzuna";
    }

    @Override
    public boolean isConfigured() {
        JobPilotProperties.Adzuna a = props.getAdzuna();
        return notBlank(a.getAppId()) && notBlank(a.getAppKey());
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        JobPilotProperties.Adzuna a = props.getAdzuna();
        String country = a.getCountry() == null ? "in" : a.getCountry();
        String query = p.getQuery();
        String where = p.getWhere() != null ? p.getWhere() : a.getWhere();
        int days = p.getMaxDaysOld() > 0 ? p.getMaxDaysOld() : 14;

        String url = UriComponentsBuilder
                .fromHttpUrl("https://api.adzuna.com/v1/api/jobs/" + country + "/search/1")
                .queryParam("app_id", a.getAppId())
                .queryParam("app_key", a.getAppKey())
                .queryParam("results_per_page", 50)
                .queryParam("what", query)
                .queryParam("where", where)
                .queryParam("max_days_old", days)
                .queryParam("content-type", "application/json")
                .build().toUriString();

        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url).retrieve().body(JsonNode.class);
            if (root == null || !root.has("results")) return out;
            for (JsonNode j : root.get("results")) {
                String desc = j.path("description").asText("");
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("id").asText(null))
                        .title(j.path("title").asText())
                        .company(j.path("company").path("display_name").asText(null))
                        .location(j.path("location").path("display_name").asText(null))
                        .description(Jsoup.parse(desc).text())
                        .url(j.path("redirect_url").asText())
                        .applyType("url")
                        .salaryText(salary(j))
                        .postedAt(parse(j.path("created").asText(null)))
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("adzuna fetch failed for query '" + query + "'", e);
        }
        return out;
    }

    private static String salary(JsonNode j) {
        if (j.has("salary_min") && j.has("salary_max")) {
            return (long) j.path("salary_min").asDouble() + " - " + (long) j.path("salary_max").asDouble();
        }
        return null;
    }

    private static Instant parse(String iso) {
        try {
            return iso == null ? null : Instant.parse(iso);
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
