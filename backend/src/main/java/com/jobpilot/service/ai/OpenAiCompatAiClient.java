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
    public String model() { return props.getGateway().getModel(); }

    @Override
    public String complete(String system, String user, boolean fast) {
        return complete(system, user, fast, null);
    }

    @Override
    public String complete(String system, String user, boolean fast, Integer maxTokens) {
        JobPilotProperties.Gateway g = props.getGateway();
        // Use the fast model only when it's a real id; otherwise fall back to the main model.
        // (Providers like OpenRouter need a concrete model id — a bare "auto" isn't valid there,
        //  though OmniRoute understands it, so we keep "auto" as the main model in that case.)
        String fastModel = g.getFastModel();
        boolean fastUsable = fastModel != null && !fastModel.isBlank() && !"auto".equalsIgnoreCase(fastModel);
        String model = (fast && fastUsable) ? fastModel : g.getModel();
        // Honour the caller's ceiling. Without this the short-JSON verdict calls reserved the
        // full configured budget through the gateway — the same reservation-vs-usage trap that
        // capped Groq at ~3 job evaluations a minute, and it matters more here because the
        // gateway fans out to free tiers whose quotas are the whole point of using it.
        int budget = maxTokens != null && maxTokens > 0
                ? Math.min(maxTokens, g.getMaxTokens()) : g.getMaxTokens();
        Map<String, Object> body = Map.of(
                "model", model,
                "temperature", 0.6,
                "max_tokens", budget,
                // MUST be explicit. Verified against a live OmniRoute 3.8.49: omitting `stream`
                // returns Server-Sent Events (`data: {...}` chunks carrying `delta.content`),
                // not a single JSON document — so the `choices[0].message.content` read below
                // finds nothing and every gateway call fails. OpenAI itself defaults to false,
                // which is exactly why this was easy to miss.
                "stream", false,
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
