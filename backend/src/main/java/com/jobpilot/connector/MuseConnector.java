package com.jobpilot.connector;

import com.fasterxml.jackson.databind.JsonNode;
import org.jsoup.Jsoup;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The Muse public jobs API — free and keyless (rate-limited, so we fetch just two
 * pages per ingest). Global listings; kept only when a location mentions India or
 * the role is flexible/remote. apply_type = url.
 */
@Component
public class MuseConnector implements JobConnector {

    private final RestClient http;

    public MuseConnector(RestClient http) {
        this.http = http;
    }

    @Override
    public String source() {
        return "muse";
    }

    @Override
    public List<RawJob> fetch(FetchParams p) {
        List<RawJob> out = new ArrayList<>();
        for (int page = 1; page <= 2; page++) {
            final int pg = page;
            try {
                JsonNode root = http.get().uri(uri -> uri
                                .scheme("https").host("www.themuse.com").path("/api/public/jobs")
                                .queryParam("category", "Software Engineering")
                                .queryParam("page", pg)
                                .build())
                        .retrieve().body(JsonNode.class);
                if (root == null || !root.has("results")) break;
                for (JsonNode j : root.get("results")) {
                    String location = firstRelevantLocation(j.path("locations"));
                    if (location == null) continue; // not India / not remote-flexible
                    String html = j.path("contents").asText("");
                    out.add(RawJob.builder()
                            .source(source())
                            .sourceJobId(j.path("id").asText(null))
                            .title(j.path("name").asText())
                            .company(j.path("company").path("name").asText(null))
                            .location(location)
                            .remote(location.toLowerCase(Locale.ROOT).contains("remote")
                                    || location.toLowerCase(Locale.ROOT).contains("flexible"))
                            .description(html.isBlank() ? "" : Jsoup.parse(html).text())
                            .url(j.path("refs").path("landing_page").asText())
                            .applyType("url")
                            .postedAt(parse(j.path("publication_date").asText(null)))
                            .build());
                }
            } catch (Exception e) {
                throw new ConnectorException("muse fetch failed (page " + pg + ")", e);
            }
        }
        return out;
    }

    /** First location that's India or flexible/remote — else null (job is skipped). */
    private static String firstRelevantLocation(JsonNode locations) {
        if (locations == null || !locations.isArray()) return null;
        for (JsonNode l : locations) {
            String name = l.path("name").asText("");
            String low = name.toLowerCase(Locale.ROOT);
            if (low.contains("india") || low.contains("remote") || low.contains("flexible")) return name;
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
}
