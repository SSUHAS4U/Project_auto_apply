package com.jobpilot.service.ai;

import com.jobpilot.config.JobPilotProperties;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * A model name the provider has retired must not be able to take the product down.
 *
 * The API keys and model names live in a {@code .env} on the deployment VM, and env always wins
 * over the repo's default. So when Groq retired llama-3.3-70b-versatile, fixing the repo would
 * still have left production calling a dead model until someone thought to edit a file on a
 * server they had no reason to suspect. These clients therefore fall forward to the verified
 * default once, remember it, and log the exact variable to change.
 *
 * Driven against a real local HTTP server rather than a mock, because the whole mechanism hangs
 * on the provider's error BODY reaching the exception message — a hand-written mock could not
 * have caught that if it didn't.
 */
class AiModelSelfHealTest {

    private HttpServer server;
    /** Model names the stub was asked for, in order. */
    private final List<String> asked = new ArrayList<>();
    private JobPilotProperties props;
    private String baseUrl;

    /** Model names this stub pretends to still host; anything else 404s the way the real API does. */
    private List<String> alive = List.of();

    /**
     * Stand-ins for the NEXT retirement — plausible names that are not in {@link RetiredModels}.
     *
     * The two paths must be tested separately. A name already in the registry is skipped before a
     * request exists, so it can never exercise the runtime healer; using one here would make
     * these tests pass while proving nothing about the case they exist for — a provider pulling a
     * model we have not catalogued yet.
     */
    private static final String UNKNOWN = "moonshotai/kimi-k2-instruct";
    private static final String UNKNOWN_FAST = "llama-4-scout-17b-16e-instruct";
    private static final String UNKNOWN_GEMINI = "gemini-2.0-flash-exp";

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::handle);
        server.setExecutor(null);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        props = new JobPilotProperties();
        props.getGroq().setApiKey("test-key");
        props.getGroq().setUrl(baseUrl + "/groq");
        props.getGemini().setApiKey("test-key");
        props.getGemini().setBaseUrl(baseUrl + "/gemini/");
    }

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    private void handle(HttpExchange ex) throws IOException {
        String path = ex.getRequestURI().getPath();
        String body = new String(readAll(ex.getRequestBody()), StandardCharsets.UTF_8);
        boolean gemini = path.startsWith("/gemini/");
        String model = gemini
                ? path.substring("/gemini/".length()).replace(":generateContent", "")
                : jsonString(body, "model");
        asked.add(model);

        if (!alive.contains(model)) {
            respond(ex, 404, gemini
                    ? "{\"error\":{\"code\":404,\"message\":\"models/" + model
                        + " is not found for API version v1beta\",\"status\":\"NOT_FOUND\"}}"
                    : "{\"error\":{\"message\":\"The model `" + model
                        + "` does not exist or you do not have access to it.\","
                        + "\"code\":\"model_not_found\"}}");
            return;
        }
        respond(ex, 200, gemini
                ? "{\"candidates\":[{\"finishReason\":\"STOP\",\"content\":{\"parts\":"
                    + "[{\"text\":\"answered by \"},{\"text\":\"" + model + "\"}]}}]}"
                : "{\"choices\":[{\"message\":{\"content\":\"answered by " + model + "\"}}]}");
    }

    private static byte[] readAll(InputStream in) throws IOException {
        return in.readAllBytes();
    }

    /** Minimal extractor — enough to read "model":"..." out of the stub's request body. */
    private static String jsonString(String json, String field) {
        String needle = "\"" + field + "\":\"";
        int i = json.indexOf(needle);
        if (i < 0) return "";
        int start = i + needle.length();
        return json.substring(start, json.indexOf('"', start));
    }

    private static void respond(HttpExchange ex, int code, String body) throws IOException {
        byte[] out = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(code, out.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(out); }
    }

    // ---- Groq -------------------------------------------------------------------------------

    @Test
    void groqFallsForwardWhenTheConfiguredModelHasBeenRetired() {
        alive = List.of(GroqAiClient.DEFAULT_MODEL);
        props.getGroq().setModel(UNKNOWN);        // a retirement not yet in RetiredModels
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        assertEquals("answered by " + GroqAiClient.DEFAULT_MODEL, c.complete("s", "u", false));
        assertEquals(List.of(UNKNOWN, GroqAiClient.DEFAULT_MODEL), asked);
    }

    @Test
    void groqRemembersTheHealSoTheDeadModelIsTriedOnlyOnce() {
        alive = List.of(GroqAiClient.DEFAULT_MODEL);
        props.getGroq().setModel(UNKNOWN);
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        c.complete("s", "u", false);
        asked.clear();
        c.complete("s", "u", false);
        // A permanent 404 must not cost a round-trip on every subsequent call.
        assertEquals(List.of(GroqAiClient.DEFAULT_MODEL), asked);
        // ...and the dashboard must name what is actually being used, not the dead string.
        assertEquals(GroqAiClient.DEFAULT_MODEL, c.model());
    }

    @Test
    void groqHealsTheFastTierIndependentlyOfTheNormalTier() {
        alive = List.of(GroqAiClient.DEFAULT_FAST_MODEL);
        props.getGroq().setFastModel(UNKNOWN_FAST);
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        assertEquals("answered by " + GroqAiClient.DEFAULT_FAST_MODEL, c.complete("s", "u", true));
        assertEquals(List.of(UNKNOWN_FAST, GroqAiClient.DEFAULT_FAST_MODEL), asked);
    }

    @Test
    void groqSurfacesTheFailureWhenEvenTheFallbackIsGone() {
        alive = List.of();                                  // everything 404s
        props.getGroq().setModel(UNKNOWN);
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        Exception e = assertThrows(Exception.class, () -> c.complete("s", "u", false));
        assertTrue(e.getMessage().contains("404"), "the real failure must reach the caller: " + e.getMessage());
        // Tried the configured name, then the fallback, then stopped — no retry loop.
        assertEquals(2, asked.size());
    }

    @Test
    void groqDoesNotTreatARateLimitAsARetirement() throws IOException {
        // A 429 is temporary and belongs to the provider rotation's cooldown, not to the model
        // healer. Healing on it would silently and permanently switch model on a busy minute.
        server.removeContext("/");
        server.createContext("/", ex -> {
            asked.add(jsonString(new String(readAll(ex.getRequestBody()), StandardCharsets.UTF_8), "model"));
            respond(ex, 429, "{\"error\":{\"message\":\"Rate limit reached. Please try again in 8.365s\","
                    + "\"code\":\"rate_limit_exceeded\"}}");
        });
        props.getGroq().setModel(UNKNOWN);
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        assertThrows(Exception.class, () -> c.complete("s", "u", false));
        assertEquals(List.of(UNKNOWN), asked, "a 429 must not trigger a model swap");
        assertEquals(UNKNOWN, c.model());
    }

    @Test
    void groqSendsReasoningEffortOnlyToModelsThatAcceptIt() throws IOException {
        List<String> bodies = new ArrayList<>();
        server.removeContext("/");
        server.createContext("/", ex -> {
            bodies.add(new String(readAll(ex.getRequestBody()), StandardCharsets.UTF_8));
            respond(ex, 200, "{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}");
        });
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        props.getGroq().setModel("openai/gpt-oss-120b");
        c.complete("s", "u", false);
        assertTrue(bodies.get(0).contains("reasoning_effort"),
                "gpt-oss spends max_tokens on hidden reasoning; low effort keeps it out of the answer");

        // groq/compound rejects reasoning_effort with a 400 — it must not be sent there.
        props.getGroq().setModel("groq/compound");
        c.complete("s", "u", false);
        assertFalse(bodies.get(1).contains("reasoning_effort"));
    }

    @Test
    void groqExplainsAnEmptyAnswerInsteadOfLookingLikeAnOutage() throws IOException {
        // A reasoning model that spends its whole budget thinking returns "" plus `reasoning`.
        // AiService would report that as a bare "empty response", which reads as a dead provider.
        server.removeContext("/");
        server.createContext("/", ex -> respond(ex, 200,
                "{\"choices\":[{\"message\":{\"content\":\"\",\"reasoning\":\"thinking...\"}}]}"));
        props.getGroq().setModel("openai/gpt-oss-120b");
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        Exception e = assertThrows(IllegalStateException.class, () -> c.complete("s", "u", false));
        assertTrue(e.getMessage().contains("reasoning"), e.getMessage());
        assertTrue(e.getMessage().contains("JOBPILOT_GROQ_MAX_TOKENS"),
                "the diagnosis must name what to change: " + e.getMessage());
    }

    @Test
    void groqNeverSendsAReasoningModelLessThanItNeedsToAnswer() throws IOException {
        List<String> bodies = new ArrayList<>();
        server.removeContext("/");
        server.createContext("/", ex -> {
            bodies.add(new String(readAll(ex.getRequestBody()), StandardCharsets.UTF_8));
            respond(ex, 200, "{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}");
        });
        props.getGroq().setModel("openai/gpt-oss-120b");
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        c.complete("s", "u", false, 20);       // an absurdly small ceiling
        assertTrue(bodies.get(0).contains("\"max_tokens\":512"),
                "hidden reasoning would consume a 20-token budget entirely: " + bodies.get(0));
    }

    @Test
    void groqNeverSendsAKnownRetiredModelAtAll() {
        // The .env on the VM still names the dead model. Falling forward AFTER a 404 works, but
        // costs a wasted round-trip on the first call after every restart, and until that call
        // lands the Settings panel displays a model that does not exist. A name already known to
        // be gone is skipped before the request is built.
        alive = List.of(GroqAiClient.DEFAULT_MODEL);
        props.getGroq().setModel("llama-3.3-70b-versatile");   // exactly what the VM .env says
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        // The panel reads model() — it must never show the dead name, not even once.
        assertEquals(GroqAiClient.DEFAULT_MODEL, c.model());
        assertEquals("answered by " + GroqAiClient.DEFAULT_MODEL, c.complete("s", "u", false));
        assertEquals(List.of(GroqAiClient.DEFAULT_MODEL), asked,
                "a known-dead model must cost zero requests, not one per restart");
    }

    @Test
    void groqSkipsAKnownRetiredFastModelToo() {
        alive = List.of(GroqAiClient.DEFAULT_FAST_MODEL);
        props.getGroq().setFastModel("llama-3.1-8b-instant");  // exactly what the VM .env says
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        assertEquals("answered by " + GroqAiClient.DEFAULT_FAST_MODEL, c.complete("s", "u", true));
        assertEquals(List.of(GroqAiClient.DEFAULT_FAST_MODEL), asked);
    }

    @Test
    void groqStillObeysAnUnrecognisedConfiguredModel() {
        // Only names PROVEN dead are overridden. Anything else is the operator's choice and is
        // sent as configured — otherwise pinning a model would silently stop working.
        alive = List.of("qwen/qwen3.8-27b");
        props.getGroq().setModel("qwen/qwen3.8-27b");
        GroqAiClient c = new GroqAiClient(props, RestClient.create());

        assertEquals("answered by qwen/qwen3.8-27b", c.complete("s", "u", false));
        assertEquals(List.of("qwen/qwen3.8-27b"), asked);
        assertEquals("qwen/qwen3.8-27b", c.model());
    }

    // ---- Gemini -----------------------------------------------------------------------------

    @Test
    void geminiFallsForwardWhenTheConfiguredModelIsNotFound() {
        alive = List.of(GeminiAiClient.DEFAULT_MODEL);
        props.getGemini().setModel(UNKNOWN_GEMINI);   // not yet in RetiredModels
        GeminiAiClient c = new GeminiAiClient(props, RestClient.create());

        assertEquals("answered by " + GeminiAiClient.DEFAULT_MODEL, c.complete("s", "u", false));
        assertEquals(List.of(UNKNOWN_GEMINI, GeminiAiClient.DEFAULT_MODEL), asked);
        assertEquals(GeminiAiClient.DEFAULT_MODEL, c.model());
    }

    @Test
    void geminiNeverSendsAKnownRetiredModelAtAll() {
        alive = List.of(GeminiAiClient.DEFAULT_MODEL);
        props.getGemini().setModel("gemini-1.5-flash");
        GeminiAiClient c = new GeminiAiClient(props, RestClient.create());

        assertEquals(GeminiAiClient.DEFAULT_MODEL, c.model());
        assertEquals("answered by " + GeminiAiClient.DEFAULT_MODEL, c.complete("s", "u", false));
        assertEquals(List.of(GeminiAiClient.DEFAULT_MODEL), asked);
    }

    @Test
    void geminiStillObeysAConfiguredModelThatIsMerelySaturated() {
        // gemini-2.5-flash exhausts fast on the free tier, but it EXISTS. Overriding it would be
        // us deciding which model the owner may pin; the rotation's cooldown handles saturation.
        alive = List.of("gemini-2.5-flash");
        props.getGemini().setModel("gemini-2.5-flash");
        GeminiAiClient c = new GeminiAiClient(props, RestClient.create());

        assertEquals("answered by gemini-2.5-flash", c.complete("s", "u", false));
        assertEquals("gemini-2.5-flash", c.model());
    }

    @Test
    void geminiUsesTheFastModelForFastCalls() {
        // The fast tier existed on Groq but not on Gemini, so every Gemini call landed on the one
        // contended model name and shared a single free-quota bucket.
        alive = List.of(GeminiAiClient.DEFAULT_MODEL, GeminiAiClient.DEFAULT_FAST_MODEL);
        GeminiAiClient c = new GeminiAiClient(props, RestClient.create());

        c.complete("s", "u", true);
        c.complete("s", "u", false);
        assertEquals(List.of(GeminiAiClient.DEFAULT_FAST_MODEL, GeminiAiClient.DEFAULT_MODEL), asked);
    }

    @Test
    void geminiJoinsEveryTextPartOfTheAnswer() {
        // The stub answers in two parts; reading parts[0] alone would truncate a cover letter
        // to its opening fragment, which is exactly what the 3.x models can produce.
        alive = List.of(GeminiAiClient.DEFAULT_MODEL);
        GeminiAiClient c = new GeminiAiClient(props, RestClient.create());

        assertEquals("answered by " + GeminiAiClient.DEFAULT_MODEL, c.complete("s", "u", false));
    }

    @Test
    void geminiSkipsThoughtPartsSoAThoughtIsNeverReturnedAsTheAnswer() throws IOException {
        server.removeContext("/");
        server.createContext("/", ex -> respond(ex, 200,
                "{\"candidates\":[{\"finishReason\":\"STOP\",\"content\":{\"parts\":["
                + "{\"thought\":true,\"text\":\"let me consider\"},{\"text\":\"the answer\"}]}}]}"));
        GeminiAiClient c = new GeminiAiClient(props, RestClient.create());

        assertEquals("the answer", c.complete("s", "u", false));
    }

    @Test
    void geminiNamesTruncationRatherThanReportingNothing() throws IOException {
        server.removeContext("/");
        server.createContext("/", ex -> respond(ex, 200,
                "{\"candidates\":[{\"finishReason\":\"MAX_TOKENS\",\"content\":{\"parts\":[]}}]}"));
        GeminiAiClient c = new GeminiAiClient(props, RestClient.create());

        Exception e = assertThrows(IllegalStateException.class, () -> c.complete("s", "u", false));
        assertTrue(e.getMessage().contains("output limit"), e.getMessage());
    }

    @Test
    void geminiDoesNotHealOnAQuotaError() throws IOException {
        // RESOURCE_EXHAUSTED is the free tier saying "later", not "gone". Healing on it would
        // permanently abandon the configured model the first busy minute of the day.
        server.removeContext("/");
        server.createContext("/", ex -> {
            asked.add(ex.getRequestURI().getPath());
            respond(ex, 429, "{\"error\":{\"code\":429,\"message\":\"You exceeded your current quota\","
                    + "\"status\":\"RESOURCE_EXHAUSTED\"}}");
        });
        props.getGemini().setModel("gemini-2.5-flash");
        GeminiAiClient c = new GeminiAiClient(props, RestClient.create());

        assertThrows(Exception.class, () -> c.complete("s", "u", false));
        assertEquals(1, asked.size(), "a quota error must not trigger a model swap");
        assertEquals("gemini-2.5-flash", c.model());
    }
}
