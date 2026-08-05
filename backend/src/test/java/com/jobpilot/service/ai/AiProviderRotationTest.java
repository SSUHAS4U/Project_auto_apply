package com.jobpilot.service.ai;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.service.SettingsService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Two free tiers should give roughly two free tiers of throughput.
 *
 * Before this, the chain was "the configured provider, then the others". Every call hit Groq
 * first, exhausted its 12,000 tokens/minute, and only then failed over — so a healthy Gemini key
 * did nothing while job evaluation stalled at a few verdicts a minute, and each of those calls
 * first paid a full round-trip to be told 429.
 */
class AiProviderRotationTest {

    /** A stub provider that records its calls and can be told to rate-limit. */
    static class StubClient implements AiClient {
        final String name;
        final List<String> calls = new ArrayList<>();
        RuntimeException failWith;
        boolean configured = true;

        StubClient(String name) { this.name = name; }

        @Override public String name() { return name; }
        @Override public boolean isConfigured() { return configured; }
        @Override public String complete(String system, String user, boolean fast) {
            calls.add(user);
            if (failWith != null) throw failWith;
            return "{\"ok\":true} from " + name;
        }
    }

    private StubClient groq;
    private StubClient gemini;
    private SettingsService settings;
    private AiService ai;

    @BeforeEach
    void setUp() {
        groq = new StubClient("groq");
        gemini = new StubClient("gemini");
        settings = Mockito.mock(SettingsService.class);
        when(settings.get(anyString())).thenReturn(Optional.empty());

        JobPilotProperties props = new JobPilotProperties();
        props.getAi().setProvider("auto");
        // A localhost Ollama is deliberately excluded from the chain; keep the default.
        ai = new AiService(List.of(groq, gemini), props, settings);
    }

    private void call(String user) { ai.complete("sys", user, false); }

    @Test
    void autoSpreadsLoadAcrossEveryConfiguredProvider() {
        for (int i = 0; i < 6; i++) call("q" + i);

        assertTrue(groq.calls.size() >= 2, "groq was starved: " + groq.calls.size());
        assertTrue(gemini.calls.size() >= 2, "gemini was starved: " + gemini.calls.size());
        assertEquals(6, groq.calls.size() + gemini.calls.size(), "every call must be served once");
        // Rotation, not randomness: with two healthy providers the split is even.
        assertEquals(3, groq.calls.size());
        assertEquals(3, gemini.calls.size());
    }

    @Test
    void aRateLimitedProviderIsRestedRatherThanReTriedFirstEveryTime() {
        groq.failWith = new IllegalStateException(
                "429 Rate limit reached ... on tokens per minute (TPM): Limit 12000, "
                + "Used 9139, Requested 4534. Please try again in 8.365s.");

        for (int i = 0; i < 6; i++) call("q" + i);

        assertEquals(6, gemini.calls.size(), "gemini must absorb the load while groq rests");
        // Groq is tried once, discovers the limit, and is then skipped — not re-hit per call.
        assertEquals(1, groq.calls.size(),
                "a provider that already said 429 must not be re-tried first on every call");
        assertTrue(ai.coolingProviders().containsKey("groq"), "groq should be resting");
    }

    @Test
    void theProvidersOwnRetryHintSetsTheRestPeriod() {
        // Gemini leads the rotation, so fail it with something that is NOT a rate limit to be
        // sure groq is actually reached and gets to report its own retry hint.
        gemini.failWith = new IllegalStateException("401 invalid api key");
        groq.failWith = new IllegalStateException("429 rate limit. Please try again in 8.365s.");

        assertThrows(IllegalStateException.class, () -> call("q"));

        long left = ai.coolingProviders().getOrDefault("groq", 0L);
        // ceil(8.365) + 1 = 10, minus a moment for the test itself.
        assertTrue(left >= 7 && left <= 10, "expected ~9s rest, got " + left);
    }

    @Test
    void anUnreachableProviderIsRestedToo() {
        // The case that matters for a SELF-HOSTED gateway (OmniRoute): it leads the chain when
        // configured, so if it isn't running, every AI call would front a connection timeout
        // before falling through. Rest it briefly rather than re-dialling a dead port per call.
        gemini.failWith = new IllegalStateException("401 invalid api key");
        groq.failWith = new IllegalStateException("I/O error on POST request: Connection refused");
        assertThrows(IllegalStateException.class, () -> call("q"));

        long left = ai.coolingProviders().getOrDefault("groq", 0L);
        assertTrue(left > 0 && left <= 60, "an unreachable provider should rest briefly, got " + left);
    }

    @Test
    void anUnreachableProviderIsSkippedRatherThanReDialledEveryCall() {
        groq.failWith = new IllegalStateException("Connection refused: connect");
        for (int i = 0; i < 6; i++) call("q" + i);
        assertEquals(1, groq.calls.size(), "a dead provider must not be dialled on every call");
        assertEquals(6, gemini.calls.size());
    }

    @Test
    void aNonRateLimitErrorDoesNotRestTheProvider() {
        // A bad key or a 404 model is a real fault to surface, not something to hide behind a
        // timer — resting it would delay the error the owner actually needs to see.
        groq.failWith = new IllegalStateException("401 invalid api key");
        call("q");
        assertFalse(ai.coolingProviders().containsKey("groq"));
    }

    @Test
    void aRecoveredProviderIsUsedAgainImmediately() {
        // Drive groq into the resting state (gemini fails non-transiently so groq is reached).
        gemini.failWith = new IllegalStateException("401 invalid api key");
        groq.failWith = new IllegalStateException("429 rate limit, try again in 5s");
        assertThrows(IllegalStateException.class, () -> call("first"));
        assertTrue(ai.coolingProviders().containsKey("groq"), "groq should be resting");

        // Now the tables turn: groq is fine, gemini is the rate-limited one. Groq is still
        // resting but must be TRIED rather than written off — if everything is cooling we would
        // rather ask and be refused than refuse on its behalf.
        groq.failWith = null;
        gemini.failWith = new IllegalStateException("429 rate limit, try again in 5s");

        String out = ai.complete("sys", "second", false);

        assertTrue(out.contains("groq"), "the resting provider must still be reachable: " + out);
        assertFalse(ai.coolingProviders().containsKey("groq"), "a success clears the rest period");
    }

    @Test
    void everyProviderFailingStillReportsWhichOnesAndWhy() {
        groq.failWith = new IllegalStateException("429 rate limit");
        gemini.failWith = new IllegalStateException("503 overloaded");

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> call("q"));
        assertTrue(e.getMessage().contains("groq"), e.getMessage());
        assertTrue(e.getMessage().contains("gemini"), e.getMessage());
    }

    @Test
    void anExplicitlyPinnedProviderStillLeads() {
        when(settings.get("ai_provider")).thenReturn(Optional.of("groq"));
        for (int i = 0; i < 4; i++) call("q" + i);
        // A pin is a deliberate choice; rotation must not override it.
        assertEquals(4, groq.calls.size());
        assertEquals(0, gemini.calls.size());
    }

    @Test
    void onlyOneProviderConfiguredStillWorks() {
        gemini.configured = false;
        for (int i = 0; i < 3; i++) call("q" + i);
        assertEquals(3, groq.calls.size());
    }

    @Test
    void readingTheStatusDoesNotAdvanceTheRotation() {
        // Settings polls this to SHOW the order and to count a resting provider down. If a read
        // spun the counter, the Groq/Gemini split would depend on whether someone had the
        // Settings tab open — which is not a property anyone would ever debug successfully.
        for (int i = 0; i < 20; i++) { ai.providerStatus(); ai.currentOrder(); }

        for (int i = 0; i < 4; i++) call("q" + i);
        assertEquals(2, groq.calls.size(), "the split must be unaffected by status polling");
        assertEquals(2, gemini.calls.size());
    }

    @Test
    void theStatusReportsTheRealModelAndRestingState() {
        List<java.util.Map<String, Object>> st = ai.providerStatus();
        var groqRow = st.stream().filter(m -> m.get("provider").equals("groq")).findFirst().orElseThrow();
        assertEquals(true, groqRow.get("configured"));
        assertEquals(true, groqRow.get("inRotation"));
        assertEquals(0L, groqRow.get("restingSeconds"));

        gemini.failWith = new IllegalStateException("401 invalid api key");
        groq.failWith = new IllegalStateException("429 rate limit, try again in 20s");
        assertThrows(IllegalStateException.class, () -> call("q"));

        groqRow = ai.providerStatus().stream()
                .filter(m -> m.get("provider").equals("groq")).findFirst().orElseThrow();
        assertTrue((Long) groqRow.get("restingSeconds") > 0, "a resting provider must say so");
    }

    @Test
    void currentOrderNamesWhatAutoWillActuallyTry() {
        List<String> order = ai.currentOrder();
        assertEquals(2, order.size());
        assertTrue(order.containsAll(List.of("groq", "gemini")), order.toString());
    }

    @Test
    void noProviderConfiguredFailsLoudlyRatherThanSilently() {
        groq.configured = false;
        gemini.configured = false;
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> call("q"));
        assertTrue(e.getMessage().toLowerCase().contains("no ai provider"), e.getMessage());
    }
}
