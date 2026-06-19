package com.jobpilot.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;

/** Local Ollama via the OpenAI-compatible /v1/chat/completions endpoint. */
@Component
public class OllamaAiClient implements AiClient {

    private final JobPilotProperties props;
    private final RestClient http;

    public OllamaAiClient(JobPilotProperties props, RestClient http) {
        this.props = props;
        this.http = http;
    }

    @Override
    public String name() {
        return "ollama";
    }

    @Override
    public boolean isConfigured() {
        // Assume a local Ollama may be running; failures fall back gracefully.
        String url = props.getOllama().getUrl();
        return url != null && !url.isBlank();
    }

    @Override
    public String complete(String system, String user, boolean fast) {
        JobPilotProperties.Ollama o = props.getOllama();
        String url = o.getUrl() + "/api/chat";
        Map<String, Object> body = Map.of(
                "model", o.getModel(),
                "stream", false,
                "options", Map.of("temperature", 0.6),
                "messages", List.of(
                        Map.of("role", "system", "content", system),
                        Map.of("role", "user", "content", user)));
        var spec = http.post().uri(url).contentType(MediaType.APPLICATION_JSON);
        if (o.getAuthHeader() != null && !o.getAuthHeader().isBlank()) {
            spec = spec.header(o.getAuthHeader(), o.getAuthValue());
        }
        JsonNode resp = spec.body(body).retrieve().body(JsonNode.class);
        if (resp == null) throw new IllegalStateException("ollama returned no response");
        JsonNode content = resp.path("message").path("content");
        if (content.isMissingNode()) throw new IllegalStateException("ollama returned no content");
        return content.asText().strip();
    }
}
