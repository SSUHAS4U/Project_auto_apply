package com.jobpilot.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;

/** Groq (OpenAI-compatible chat completions). Fast + free tier. */
@Component
public class GroqAiClient implements AiClient {

    private final JobPilotProperties props;
    private final RestClient http;

    public GroqAiClient(JobPilotProperties props, RestClient http) {
        this.props = props;
        this.http = http;
    }

    @Override
    public String name() {
        return "groq";
    }

    @Override
    public boolean isConfigured() {
        String k = props.getGroq().getApiKey();
        return k != null && !k.isBlank();
    }

    @Override
    public String complete(String system, String user, boolean fast) {
        JobPilotProperties.Groq g = props.getGroq();
        String model = fast ? g.getFastModel() : g.getModel();
        Map<String, Object> body = Map.of(
                "model", model,
                "temperature", 0.6,
                "max_tokens", 2000,
                "messages", List.of(
                        Map.of("role", "system", "content", system),
                        Map.of("role", "user", "content", user)));
        JsonNode resp = http.post().uri(g.getUrl())
                .header("Authorization", "Bearer " + g.getApiKey())
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(JsonNode.class);
        if (resp == null) throw new IllegalStateException("groq returned no response");
        JsonNode content = resp.path("choices").path(0).path("message").path("content");
        if (content.isMissingNode()) {
            throw new IllegalStateException("groq returned no content: " + resp);
        }
        return content.asText().strip();
    }

    /**
     * Raw chat-completions call supporting tool/function calling. Returns the
     * assistant message node (may contain {@code content} and/or {@code tool_calls}).
     */
    public JsonNode chat(List<Map<String, Object>> messages, List<Map<String, Object>> tools) {
        JobPilotProperties.Groq g = props.getGroq();
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("model", g.getModel());
        body.put("temperature", 0.7);
        body.put("max_tokens", 1500);
        body.put("messages", messages);
        if (tools != null && !tools.isEmpty()) {
            body.put("tools", tools);
            body.put("tool_choice", "auto");
        }
        JsonNode resp = http.post().uri(g.getUrl())
                .header("Authorization", "Bearer " + g.getApiKey())
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(JsonNode.class);
        if (resp == null) throw new IllegalStateException("groq returned no response");
        JsonNode msg = resp.path("choices").path(0).path("message");
        if (msg.isMissingNode()) throw new IllegalStateException("groq returned no message: " + resp);
        return msg;
    }
}
