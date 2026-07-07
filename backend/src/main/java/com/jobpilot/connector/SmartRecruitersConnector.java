package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Public SmartRecruiters postings API (keyless). apply_type = ats. */
@Component
public class SmartRecruitersConnector implements JobConnector {

    private final RestClient http;

    public SmartRecruitersConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "smartrecruiters";
    }

    @Override
    public boolean isPerBoard() {
        return true;
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        String token = p.getBoardToken();
        // country=in: big multinationals (Bosch: 4600+ global postings) would otherwise
        // flood the fetch with roles the India relevance gate rejects anyway.
        String url = "https://api.smartrecruiters.com/v1/companies/" + token + "/postings?country=in&limit=100";
        List<RawJob> out = new ArrayList<>();
        try {
            JsonNode root = http.get().uri(url).retrieve().body(JsonNode.class);
            if (root == null || !root.has("content")) return out;
            for (JsonNode j : root.get("content")) {
                JsonNode loc = j.path("location");
                String city = loc.path("city").asText("");
                String country = loc.path("country").asText("");
                boolean remote = loc.path("remote").asBoolean(false);
                String location = (city + (country.isBlank() ? "" : ", " + country.toUpperCase(Locale.ROOT))).trim();
                String companyId = j.path("company").path("identifier").asText(token);
                out.add(RawJob.builder()
                        .source(source())
                        .sourceJobId(j.path("id").asText(null))
                        .title(j.path("name").asText())
                        .company(p.getCompany())
                        .location(location.isBlank() ? null : location)
                        .remote(remote)
                        .description("")
                        .url("https://jobs.smartrecruiters.com/" + companyId + "/" + j.path("id").asText())
                        .applyType("ats")
                        .postedAt(parse(j.path("releasedDate").asText(null)))
                        .build());
            }
        } catch (Exception e) {
            throw new ConnectorException("smartrecruiters fetch failed for board " + token, e);
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
