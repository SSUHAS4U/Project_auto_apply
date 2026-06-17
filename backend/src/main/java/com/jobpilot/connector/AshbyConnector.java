package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.jsoup.Jsoup;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.ArrayList;
import java.util.List;

/** Ashby public job board API. apply_type = ats. */
@Component
public class AshbyConnector implements JobConnector {

    private final RestClient http;

    public AshbyConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "ashby";
    }

    @Override
    public boolean isPerBoard() {
        return true;
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String board = p.getBoardToken();
        String url = "https://api.ashbyhq.com/posting-api/job-board/" + board + "?includeCompensation=true";
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url)
                    .accept(MediaType.APPLICATION_JSON)
                    .retrieve().body(JsonNode.class);
            if (root == null || !root.has("jobs")) return out;
            for (JsonNode j : root.get("jobs")) {
                String html = j.path("descriptionHtml").asText("");
                String desc = html.isBlank() ? j.path("descriptionPlain").asText("") : Jsoup.parse(html).text();
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("id").asText(null))
                        .title(j.path("title").asText())
                        .company(p.getCompany())
                        .location(j.path("location").asText(null))
                        .remote(j.path("isRemote").asBoolean(false))
                        .description(desc)
                        .url(j.path("jobUrl").asText(j.path("applyUrl").asText()))
                        .applyType("ats")
                        .salaryText(j.path("compensation").path("compensationTierSummary").asText(null))
                        .raw(j.toString())
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("ashby fetch failed for " + board, e);
        }
        return out;
    }
}
