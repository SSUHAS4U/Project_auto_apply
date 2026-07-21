package com.jobpilot.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;

/**
 * Generic OpenAI-compatible chat-completions client ("gateway").
 *
 * Its whole point is to let JobPilot sit behind an <b>OmniRoute</b> AI gateway
 * (https://github.com/diegosouzapw/OmniRoute) via its OpenAI-compatible {@code /v1} API:
 * set {@code jobpilot.gateway.url} to {@code http://<host>:20128/v1/chat/completions} and a
 * single request fans out across OmniRoute's many providers with its own smart fallback,
 * quota-aware routing and token compression. It works equally well pointed at any other
 * {@code /v1}-compatible endpoint (OpenRouter, Cerebras, Together, …).
 *
 * Opt-in and non-invasive: when the URL is blank this client reports {@code isConfigured()
 * == false}, so {@link AiService} skips it and behaves exactly as before (Gemini → Groq).
 * When set, it becomes the primary provider and the direct Gemini/Groq clients remain as an
 * automatic backstop in the fallback chain.
 */
@Component
public class OpenAiCompatAiClient implements AiClient {

    private final JobPilotProperties props;
    private final RestClient http;

    public OpenAiCompatAiClient(JobPilotProperties props, RestClient http) {
        this.props = props;
        this.http = http;
    }

    @Override
    public String name() {
        return "gateway";
    }

    @Override
    public boolean isConfigured() {
        String u = props.getGateway().getUrl();
        return u != null && !u.isBlank();
    }

    @Override
    public String complete(String system, String user, boolean fast) {
        JobPilotProperties.Gateway g = props.getGateway();
        String model = fast ? g.getFastModel() : g.getModel();
        Map<String, Object> body = Map.of(
                "model", model,
                "temperature", 0.6,
                "max_tokens", g.getMaxTokens(),
                "messages", List.of(
                        Map.of("role", "system", "content", system),
                        Map.of("role", "user", "content", user)));

        RestClient.RequestBodySpec req = http.post().uri(g.getUrl())
                .contentType(MediaType.APPLICATION_JSON);
        // Bearer auth is optional — a local/self-hosted OmniRoute may not require a key.
        if (g.getApiKey() != null && !g.getApiKey().isBlank()) {
            req = req.header("Authorization", "Bearer " + g.getApiKey());
        }
        JsonNode resp = req.body(body).retrieve().body(JsonNode.class);
        if (resp == null) throw new IllegalStateException("gateway returned no response");
        JsonNode content = resp.path("choices").path(0).path("message").path("content");
        if (content.isMissingNode()) {
            throw new IllegalStateException("gateway returned no content: " + resp);
        }
        return content.asText().strip();
    }
}
