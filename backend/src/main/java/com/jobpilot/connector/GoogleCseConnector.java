package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.ArrayList;
import java.util.List;

/**
 * "Search Google for jobs" — via the official Google Custom Search JSON API
 * (free tier: 100 queries/day). Point a Programmable Search Engine at job sites
 * and this returns those results as url-apply jobs. Disabled until keys are set.
 *
 * Get the two free values:
 *   1. API key:  https://developers.google.com/custom-search/v1/introduction
 *   2. Engine id (cx): https://programmablesearchengine.google.com/ (set it to
 *      "Search the entire web" or scope it to job boards)
 */
@Component
public class GoogleCseConnector implements JobConnector {

    private final RestClient http;
    private final JobPilotProperties props;

    public GoogleCseConnector(RestClient http, JobPilotProperties props) {
        this.http = http;
        this.props = props;
    }

    @Override
    public String source() {
        return "google";
    }

    @Override
    public boolean isConfigured() {
        JobPilotProperties.GoogleCse g = props.getGoogleCse();
        return notBlank(g.getApiKey()) && notBlank(g.getCx())
                && g.getQueries() != null && !g.getQueries().isEmpty();
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        JobPilotProperties.GoogleCse g = props.getGoogleCse();
        String q = p.getQuery();
        String url = UriComponentsBuilder
                .fromHttpUrl("https://www.googleapis.com/customsearch/v1")
                .queryParam("key", g.getApiKey())
                .queryParam("cx", g.getCx())
                .queryParam("q", q)
                .queryParam("num", 10)
                .queryParam("dateRestrict", "d7")   // last 7 days
                .build().toUriString();

        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url).retrieve().body(JsonNode.class);
            if (root == null || !root.has("items")) return out;
            for (JsonNode it : root.get("items")) {
                out.add(RawJob.builder()
                        .source(source())
                        .title(it.path("title").asText())
                        .company(it.path("displayLink").asText(null))
                        .description(it.path("snippet").asText(""))
                        .url(it.path("link").asText())
                        .applyType("url")
                        .raw(it.toString())
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("google cse fetch failed for '" + q + "'", e);
        }
        return out;
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
