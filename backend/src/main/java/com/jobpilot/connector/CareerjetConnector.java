package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

/** Careerjet public search API (India locale). Needs an affiliate id. apply_type = url. */
@Component
public class CareerjetConnector implements JobConnector {

    private static final DateTimeFormatter DMY = DateTimeFormatter.ofPattern("dd/MM/yyyy");

    private final RestClient http;
    private final JobPilotProperties props;

    public CareerjetConnector(RestClient http, JobPilotProperties props) {
        this.http = http;
        this.props = props;
    }

    @Override
    public String source() {
        return "careerjet";
    }

    @Override
    public boolean isConfigured() {
        return notBlank(props.getCareerjet().getAffid());
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        JobPilotProperties.Careerjet c = props.getCareerjet();
        String keywords = p.getQuery() == null ? "software engineer" : p.getQuery();
        String where = p.getWhere() != null ? p.getWhere() : c.getWhere();

        String url = UriComponentsBuilder.fromHttpUrl("http://public.api.careerjet.net/search")
                .queryParam("locale_code", c.getLocale())
                .queryParam("keywords", keywords)
                .queryParam("location", where)
                .queryParam("affid", c.getAffid())
                .queryParam("pagesize", 50)
                .queryParam("page", 1)
                // Careerjet requires caller identification on every request.
                .queryParam("user_ip", "203.0.113.1")
                .queryParam("user_agent", "JobPilot/1.0")
                .build().toUriString();

        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url)
                    .header("Referer", "https://jobpilot.app")
                    .header("User-Agent", "JobPilot/1.0")
                    .header("accept", "application/json")
                    .retrieve().body(JsonNode.class);
            if (root == null || !root.has("jobs")) return out;
            for (JsonNode j : root.get("jobs")) {
                String desc = j.path("description").asText("");
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(null)
                        .title(j.path("title").asText())
                        .company(emptyToNull(j.path("company").asText(null)))
                        .location(emptyToNull(j.path("locations").asText(null)))
                        .description(desc.isBlank() ? "" : Jsoup.parse(desc).text())
                        .url(j.path("url").asText())
                        .applyType("url")
                        .salaryText(emptyToNull(j.path("salary").asText(null)))
                        .postedAt(parseDmy(j.path("date").asText(null)))
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("careerjet fetch failed for query '" + keywords + "'", e);
        }
        return out;
    }

    private static Instant parseDmy(String s) {
        try {
            if (s == null || s.isBlank()) return null;
            return LocalDate.parse(s.trim(), DMY).atStartOfDay(ZoneOffset.UTC).toInstant();
        } catch (Exception e) {
            return null;
        }
    }

    private static String emptyToNull(String s) {
        return (s == null || s.isBlank()) ? null : s;
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
