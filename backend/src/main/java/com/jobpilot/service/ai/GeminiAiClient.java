package com.jobpilot.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/** Google Gemini generateContent. */
@Component
public class GeminiAiClient implements AiClient {

    private static final Logger log = LoggerFactory.getLogger(GeminiAiClient.class);

    /**
     * The models this build was verified against.
     *
     * gemini-2.5-flash was not retired, but on the free tier it is the most heavily contended
     * model Google offers, and its per-minute quota is shared with everything else pointed at
     * that name. Measured on the owner's key: ten short requests in a row exhausted it
     * (RESOURCE_EXHAUSTED) while gemini-3.5-flash and gemini-3.1-flash-lite answered normally —
     * each model name has its own bucket. Pointing the two tiers at two different models
     * therefore doubles the usable free throughput as well as upgrading the model.
     */
    static final String DEFAULT_MODEL = "gemini-3.5-flash";
    static final String DEFAULT_FAST_MODEL = "gemini-3.1-flash-lite";

    /** Google reports a removed or misspelled model as 404 NOT_FOUND on the version prefix. */
    private static final Pattern RETIRED = Pattern.compile(
            "is not found for API version|NOT_FOUND|was not found|404", Pattern.CASE_INSENSITIVE);

    /** See {@link GroqAiClient} — a retired name is a permanent 404, so heal it once and log how. */
    private final Map<String, String> healed = new ConcurrentHashMap<>();

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
    public String model() { return effective(props.getGemini().getModel(), DEFAULT_MODEL); }

    /** As in the groq client: a known-dead name is skipped before the request is built. */
    private String effective(String configured, String fallback) {
        if (configured == null || configured.isBlank()) return fallback;
        if (RetiredModels.isRetired(configured) && !configured.equals(fallback)) {
            if (healed.putIfAbsent(configured, fallback) == null) {
                log.warn("Gemini model '{}' is a retired model and is being ignored; using '{}' "
                        + "instead. Set JOBPILOT_GEMINI_MODEL / JOBPILOT_GEMINI_FAST_MODEL in the "
                        + "backend .env (on the VM, ~/jobpilot/.env — the file its docker-compose.yml loads) to stop configuring a model "
                        + "that no longer exists.", configured, fallback);
            }
            return fallback;
        }
        return healed.getOrDefault(configured, configured);
    }

    @Override
    public String complete(String system, String user, boolean fast) {
        return complete(system, user, fast, null);
    }

    @Override
    public String complete(String system, String user, boolean fast, Integer maxTokens) {
        JobPilotProperties.Gemini gm = props.getGemini();
        String configured = fast ? gm.getFastModel() : gm.getModel();
        String fallback = fast ? DEFAULT_FAST_MODEL : DEFAULT_MODEL;
        String model = effective(configured, fallback);
        int budget = maxTokens != null && maxTokens > 0 ? Math.min(maxTokens, MAX_OUTPUT) : MAX_OUTPUT;
        try {
            return send(model, system, user, budget);
        } catch (Exception e) {
            String msg = e.getMessage() == null ? e.toString() : e.getMessage();
            if (!RETIRED.matcher(msg).find() || model.equals(fallback)) throw e;
            healed.put(configured, fallback);
            log.error("Gemini model '{}' is not available on this API version/key (404). "
                    + "Falling forward to '{}' for the rest of this process. To make it permanent, "
                    + "set JOBPILOT_GEMINI_MODEL / JOBPILOT_GEMINI_FAST_MODEL in the backend .env "
                    + "(on the VM, ~/jobpilot/.env — the file its docker-compose.yml loads) to a model listed by "
                    + "GET {}?key=... , then restart the backend.", configured, fallback, base());
            return send(fallback, system, user, budget);
        }
    }

    /** Ceiling for a single answer. Every current flash model allows 65,536; this is a cost guard. */
    private static final int MAX_OUTPUT = 8192;

    /** Always ends in "/" so a model name can be appended directly. */
    private String base() {
        String b = props.getGemini().getBaseUrl();
        if (b == null || b.isBlank()) b = "https://generativelanguage.googleapis.com/v1beta/models/";
        return b.endsWith("/") ? b : b + "/";
    }

    private String send(String model, String system, String user, int budget) {
        String key = props.getGemini().getApiKey();
        String url = base() + model + ":generateContent?key=" + key;
        // Disable "thinking" so the token budget isn't spent on hidden reasoning. Verified against
        // the live API on the 3.x models: thinkingBudget:0 returns no thoughtsTokenCount at all,
        // while thinkingLevel:"low" still burned 416 thought tokens on a one-sentence answer and
        // omitting the block entirely burned 471. On the free tier that is the difference between
        // ~40 and ~500 billed tokens per call, i.e. how fast the daily quota runs out.
        Map<String, Object> body = Map.of(
                "systemInstruction", Map.of("parts", List.of(Map.of("text", system))),
                "contents", List.of(Map.of("parts", List.of(Map.of("text", user)))),
                "generationConfig", Map.of(
                        "maxOutputTokens", budget,
                        "temperature", 0.6,
                        "thinkingConfig", Map.of("thinkingBudget", 0)));
        // Pass the API key both as a query parameter and as the x-goog-api-key header
        // to support all key formats (AQ.- and AIza- prefixed keys).
        JsonNode resp = http.post().uri(url)
                .header("x-goog-api-key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(JsonNode.class);
        if (resp == null) throw new IllegalStateException("gemini returned no response");
        JsonNode candidate = resp.path("candidates").path(0);
        String text = textOf(candidate);
        if (text.isEmpty()) {
            // A truncated answer and a blocked one both arrive as "no text"; the finishReason is
            // the only thing that tells them apart, so put it in the message rather than the blob.
            String finish = candidate.path("finishReason").asText("");
            if ("MAX_TOKENS".equals(finish)) {
                throw new IllegalStateException("gemini (" + model + ") hit the " + budget
                        + "-token output limit before answering. Raise the caller's budget.");
            }
            throw new IllegalStateException("gemini (" + model + ") returned no text"
                    + (finish.isBlank() ? "" : " (finishReason=" + finish + ")") + ": " + resp);
        }
        return text;
    }

    /**
     * Join every text part of the answer.
     *
     * Reading {@code parts[0].text} was safe while only 2.5-flash was in use, but the 3.x models
     * can return a thought-summary part first and split long answers across parts — taking index
     * zero would silently truncate a cover letter to its opening line, or read a thought as the
     * answer. Thought parts are marked and skipped.
     */
    private static String textOf(JsonNode candidate) {
        StringBuilder sb = new StringBuilder();
        for (JsonNode part : candidate.path("content").path("parts")) {
            if (part.path("thought").asBoolean(false)) continue;
            String t = part.path("text").asText("");
            if (!t.isEmpty()) sb.append(t);
        }
        return sb.toString().strip();
    }
}
