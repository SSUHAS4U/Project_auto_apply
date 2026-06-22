package com.jobpilot.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.domain.Job;
import org.jsoup.Jsoup;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Fetches a single job's full description ON DEMAND (for cover letters), so the model
 * has real role-specific content. We deliberately don't store descriptions during bulk
 * ingest (memory), so this fills the gap only when a letter is actually being written.
 */
@Service
public class JobDescriptionService {

    private static final Logger log = LoggerFactory.getLogger(JobDescriptionService.class);
    private static final Pattern GH = Pattern.compile("greenhouse\\.io/([^/?#]+)/jobs/(\\d+)");

    private final RestClient http;

    // Small cache so re-previewing the same job doesn't re-fetch.
    private final Map<String, String> cache = Collections.synchronizedMap(
            new LinkedHashMap<>(64, 0.75f, true) {
                @Override protected boolean removeEldestEntry(Map.Entry<String, String> e) { return size() > 120; }
            });

    public JobDescriptionService(RestClient http) {
        this.http = http;
    }

    /** Best-effort full description; falls back to whatever the job already has. */
    public String fetch(Job job) {
        String existing = job.getDescription();
        if (existing != null && existing.strip().length() > 250) return existing; // already rich enough
        String url = job.getUrl();
        if (url == null || url.isBlank()) return safe(existing);
        String hit = cache.get(url);
        if (hit != null) return hit;

        String desc = null;
        try {
            Matcher m = GH.matcher(url);
            if (m.find()) desc = fetchGreenhouse(m.group(1), m.group(2));
            if (isThin(desc)) desc = scrapePage(url);
        } catch (Exception e) {
            log.debug("description fetch failed for {}: {}", url, e.getMessage());
        }
        if (isThin(desc)) desc = safe(existing);
        if (desc.length() > 3500) desc = desc.substring(0, 3500);
        if (!desc.isBlank()) cache.put(url, desc);
        return desc;
    }

    private String fetchGreenhouse(String board, String id) {
        String api = "https://boards-api.greenhouse.io/v1/boards/" + board + "/jobs/" + id + "?content=true";
        JsonNode root = http.get().uri(api).retrieve().body(JsonNode.class);
        if (root == null) return null;
        String content = root.path("content").asText("");
        // Greenhouse encodes HTML entities; unescape via Jsoup then strip tags.
        return content.isBlank() ? null : Jsoup.parse(org.jsoup.parser.Parser.unescapeEntities(content, false)).text();
    }

    private String scrapePage(String url) {
        try {
            String html = http.get().uri(url)
                    .header("User-Agent", "Mozilla/5.0 (compatible; JobPilot/1.0)")
                    .retrieve().body(String.class);
            if (html == null) return null;
            var doc = Jsoup.parse(html);
            // Prefer a description-like container; else the whole body text.
            for (String sel : new String[]{"[class*=description]", "[class*=job]", "#content", "article", "main"}) {
                var el = doc.selectFirst(sel);
                if (el != null && el.text().length() > 250) return el.text();
            }
            return doc.body() != null ? doc.body().text() : doc.text();
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isThin(String s) { return s == null || s.strip().length() < 120; }
    private static String safe(String s) { return s == null ? "" : s; }
}
