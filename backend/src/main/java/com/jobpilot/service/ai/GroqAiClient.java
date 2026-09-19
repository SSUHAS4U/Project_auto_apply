package com.jobpilot.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/** Groq (OpenAI-compatible chat completions). Fast + free tier. */
@Component
public class GroqAiClient implements AiClient {

    private static final Logger log = LoggerFactory.getLogger(GroqAiClient.class);

    /**
     * The models this build was verified against, and the target of the decommission self-heal.
     *
     * Groq retires hosted models outright — the endpoint answers 404 {@code model_not_found}, not
     * a deprecation warning. Both previous defaults (llama-3.3-70b-versatile, llama-3.1-8b-instant)
     * were removed from the catalogue, which took every Groq call in the product down at once:
     * the extension's field fill, the AI answers, and the saved-answer learning all sit behind
     * {@link com.jobpilot.service.AiService}, so one dead model name broke all three.
     */
    static final String DEFAULT_MODEL = "openai/gpt-oss-120b";
    static final String DEFAULT_FAST_MODEL = "openai/gpt-oss-20b";

    /**
     * A retired model name is a permanent 404, so retrying it is pure latency. When one is hit we
     * fall forward to the verified default ONCE, remember the mapping for the process, and say so
     * in the log with the exact variable to change. Without this, a stale {@code .env} on the
     * deployment VM keeps the product broken even after the repo is fixed — env always wins over
     * the yaml default, and nobody edits a VM file they have no reason to suspect.
     */
    private final Map<String, String> healed = new ConcurrentHashMap<>();

    /** Groq answers a retired model with 404 model_not_found / model_decommissioned. */
    private static final Pattern RETIRED = Pattern.compile(
            "model_not_found|model_decommissioned|decommissioned|does not exist or you do not have access",
            Pattern.CASE_INSENSITIVE);

    /**
     * Models that spend part of {@code max_tokens} on hidden reasoning before answering.
     *
     * gpt-oss and qwen3 both do. Left at Groq's default effort, a short-JSON caller (the fit
     * verdict asks for 400 tokens) can have the whole budget eaten by reasoning and get back an
     * empty {@code content} — which AiService correctly reports as "empty response" and which
     * looks exactly like an outage. {@code reasoning_effort:"low"} holds it to ~30-50 tokens.
     */
    private static final Pattern REASONING_MODEL = Pattern.compile("gpt-oss|qwen3", Pattern.CASE_INSENSITIVE);

    /**
     * Not every Groq model accepts {@code reasoning_effort} — groq/compound rejects it with a 400.
     * So the parameter is sent only to the models that document it.
     */
    private static boolean isReasoningModel(String model) {
        return model != null && REASONING_MODEL.matcher(model).find();
    }

    /** Floor for a reasoning model's budget so hidden reasoning cannot starve the answer. */
    private static final int REASONING_FLOOR = 512;

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
    public String model() { return effective(props.getGroq().getModel(), DEFAULT_MODEL); }

    /**
     * The name actually sent: the configured one, or its replacement if it has been retired.
     *
     * A name already known to be dead is skipped here, before the request is built, so it never
     * costs a 404 and never reaches the Settings panel. A retirement we have not seen before
     * still gets discovered the hard way, by {@link #healFor}, and is remembered from then on.
     */
    private String effective(String configured, String fallback) {
        if (configured == null || configured.isBlank()) return fallback;
        if (RetiredModels.isRetired(configured) && !configured.equals(fallback)) {
            noteKnownRetired(configured, fallback);
            return fallback;
        }
        return healed.getOrDefault(configured, configured);
    }

    /** Record the substitution and say it once — this is read on every Settings poll. */
    private void noteKnownRetired(String configured, String fallback) {
        if (healed.putIfAbsent(configured, fallback) == null) {
            log.warn("Groq model '{}' is a retired model and is being ignored; using '{}' instead. "
                    + "Set JOBPILOT_GROQ_MODEL / JOBPILOT_GROQ_FAST_MODEL in the backend .env "
                    + "(on the VM, ~/jobpilot/.env — the file its docker-compose.yml loads) to stop configuring a model that no longer "
                    + "exists.", configured, fallback);
        }
    }

    @Override
    public String complete(String system, String user, boolean fast) {
        return complete(system, user, fast, null);
    }

    @Override
    public String complete(String system, String user, boolean fast, Integer maxTokens) {
        JobPilotProperties.Groq g = props.getGroq();
        String configured = fast ? g.getFastModel() : g.getModel();
        String fallback = fast ? DEFAULT_FAST_MODEL : DEFAULT_MODEL;
        String model = effective(configured, fallback);
        // Groq's on-demand tier is 8,000 tokens/minute per model (measured against the live API
        // via x-ratelimit-limit-tokens). It bills what a request USES, not what it reserves — a
        // large max_tokens no longer costs the whole minute's budget, which it did on the old
        // llama tier. Callers that only need a short JSON verdict still pass their own ceiling;
        // the configured value is the default and is sized for a CV/cover letter.
        int budget = maxTokens != null && maxTokens > 0
                ? Math.min(maxTokens, g.getMaxTokens()) : g.getMaxTokens();
        try {
            return send(model, system, user, budget);
        } catch (Exception e) {
            String replacement = healFor(e, configured, fallback, model);
            if (replacement == null) throw e;
            return send(replacement, system, user, budget);
        }
    }

    /**
     * Decide whether a failure is "this model no longer exists" and, if so, register and return
     * the replacement to retry with. Returns null for every other failure — a 401, a 429 or a
     * network fault must surface to the fallback chain, not be disguised as a model change.
     */
    private String healFor(Exception e, String configured, String fallback, String tried) {
        String msg = e.getMessage() == null ? e.toString() : e.getMessage();
        if (!RETIRED.matcher(msg).find()) return null;
        if (tried.equals(fallback)) return null;          // the fallback itself is gone — surface it
        healed.put(configured, fallback);
        log.error("Groq model '{}' has been retired by Groq (404 model_not_found). "
                + "Falling forward to '{}' for the rest of this process. "
                + "To make it permanent, set JOBPILOT_GROQ_MODEL / JOBPILOT_GROQ_FAST_MODEL in the "
                + "backend .env (on the VM, ~/jobpilot/.env — the file its docker-compose.yml loads) to a model listed by "
                + "GET https://api.groq.com/openai/v1/models, then restart the backend.",
                configured, fallback);
        return fallback;
    }

    private String send(String model, String system, String user, int budget) {
        JobPilotProperties.Groq g = props.getGroq();
        boolean reasoning = isReasoningModel(model);
        Map<String, Object> body = new HashMap<>();
        body.put("model", model);
        body.put("temperature", 0.6);
        body.put("max_tokens", reasoning ? Math.max(budget, REASONING_FLOOR) : budget);
        body.put("messages", List.of(
                Map.of("role", "system", "content", system),
                Map.of("role", "user", "content", user)));
        if (reasoning) body.put("reasoning_effort", "low");
        JsonNode resp = http.post().uri(g.getUrl())
                .header("Authorization", "Bearer " + g.getApiKey())
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(JsonNode.class);
        if (resp == null) throw new IllegalStateException("groq returned no response");
        JsonNode message = resp.path("choices").path(0).path("message");
        JsonNode content = message.path("content");
        if (content.isMissingNode()) {
            throw new IllegalStateException("groq returned no content: " + resp);
        }
        String text = content.asText("").strip();
        if (text.isEmpty()) {
            // A reasoning model that spent the whole budget thinking answers with an empty string
            // and a populated `reasoning`. Say that, rather than let it read as an outage.
            String why = message.path("reasoning").asText("").isBlank()
                    ? "the model returned an empty message"
                    : "the model spent its entire " + budget + "-token budget on reasoning";
            throw new IllegalStateException("groq (" + model + ") returned no answer — " + why
                    + ". Raise JOBPILOT_GROQ_MAX_TOKENS or use a non-reasoning model.");
        }
        return text;
    }

    /**
     * Raw chat-completions call supporting tool/function calling. Returns the
     * assistant message node (may contain {@code content} and/or {@code tool_calls}).
     */
    public JsonNode chat(List<Map<String, Object>> messages, List<Map<String, Object>> tools) {
        JobPilotProperties.Groq g = props.getGroq();
        String configured = g.getModel();
        String model = effective(configured, DEFAULT_MODEL);
        try {
            return chatOnce(model, messages, tools);
        } catch (Exception e) {
            String replacement = healFor(e, configured, DEFAULT_MODEL, model);
            if (replacement == null) throw e;
            return chatOnce(replacement, messages, tools);
        }
    }

    private JsonNode chatOnce(String model, List<Map<String, Object>> messages,
                              List<Map<String, Object>> tools) {
        JobPilotProperties.Groq g = props.getGroq();
        Map<String, Object> body = new HashMap<>();
        body.put("model", model);
        body.put("temperature", 0.7);
        body.put("max_tokens", 1500);
        body.put("messages", messages);
        if (isReasoningModel(model)) body.put("reasoning_effort", "low");
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
