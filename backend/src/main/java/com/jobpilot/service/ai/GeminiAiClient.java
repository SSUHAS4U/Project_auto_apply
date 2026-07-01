package com.jobpilot.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;

/** Google Gemini generateContent. */
@Component
public class GeminiAiClient implements AiClient {

    private final JobPilotProperties props;
    private final RestClient http;

    public GeminiAiClient(JobPilotProperties props, RestClient http) {
        this.props = props;
        this.http = http;
    }

    @Override
    public String name() {
        return "gemini";
    }

    @Override
    public boolean isConfigured() {
        String k = props.getGemini().getApiKey();
        return k != null && !k.isBlank();
    }

    @Override
    public String complete(String system, String user, boolean fast) {
        String key = props.getGemini().getApiKey();
        String url = "https://generativelanguage.googleapis.com/v1beta/models/"
                + props.getGemini().getModel() + ":generateContent";
        // Disable "thinking" so the token budget isn't spent on hidden reasoning
        // (2.5-flash otherwise truncates the visible answer). Cap output tokens.
        Map<String, Object> body = Map.of(
                "systemInstruction", Map.of("parts", List.of(Map.of("text", system))),
                "contents", List.of(Map.of("parts", List.of(Map.of("text", user)))),
                "generationConfig", Map.of(
                        "maxOutputTokens", 2000,
                        "temperature", 0.6,
                        "thinkingConfig", Map.of("thinkingBudget", 0)));
        // Google's new AQ.-format auth keys require the x-goog-api-key header
        // (the old ?key= query parameter is rejected for new-format keys).
        JsonNode resp = http.post().uri(url)
                .header("x-goog-api-key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(JsonNode.class);
        if (resp == null) throw new IllegalStateException("gemini returned no response");
        JsonNode text = resp.path("candidates").path(0).path("content").path("parts").path(0).path("text");
        if (text.isMissingNode()) throw new IllegalStateException("gemini returned no text: " + resp);
        return text.asText().strip();
    }
}
