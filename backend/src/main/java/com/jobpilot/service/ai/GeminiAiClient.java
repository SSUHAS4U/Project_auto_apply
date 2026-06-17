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
                + props.getGemini().getModel() + ":generateContent?key=" + key;
        Map<String, Object> body = Map.of(
                "systemInstruction", Map.of("parts", List.of(Map.of("text", system))),
                "contents", List.of(Map.of("parts", List.of(Map.of("text", user)))));
        JsonNode resp = http.post().uri(url)
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
