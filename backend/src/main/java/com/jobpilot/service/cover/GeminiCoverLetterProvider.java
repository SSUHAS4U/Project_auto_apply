package com.jobpilot.service.cover;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;

/** Optional Gemini free-tier provider. */
@Component
public class GeminiCoverLetterProvider implements CoverLetterProvider {

    private final JobPilotProperties props;
    private final RestClient http;

    public GeminiCoverLetterProvider(JobPilotProperties props, RestClient http) {
        this.props = props;
        this.http = http;
    }

    @Override
    public String name() {
        return "gemini";
    }

    @Override
    public String generate(Job job, Profile profile) {
        String key = props.getGemini().getApiKey();
        if (key == null || key.isBlank()) {
            throw new IllegalStateException("gemini api key not configured");
        }
        String url = "https://generativelanguage.googleapis.com/v1beta/models/"
                + props.getGemini().getModel() + ":generateContent?key=" + key;
        Map<String, Object> body = Map.of(
                "contents", List.of(Map.of(
                        "parts", List.of(Map.of("text", CoverLetterPrompt.build(job, profile))))));
        JsonNode resp = http.post().uri(url)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(JsonNode.class);
        if (resp == null) throw new IllegalStateException("gemini returned no response");
        JsonNode text = resp.path("candidates").path(0).path("content").path("parts").path(0).path("text");
        if (text.isMissingNode()) throw new IllegalStateException("gemini returned no text");
        return text.asText().strip();
    }
}
