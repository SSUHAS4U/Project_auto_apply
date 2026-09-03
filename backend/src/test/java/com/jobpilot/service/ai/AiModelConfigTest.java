package com.jobpilot.service.ai;

import com.jobpilot.config.JobPilotProperties;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Guards the model names against the failure that produced this test.
 *
 * Groq retired {@code llama-3.3-70b-versatile} and {@code llama-3.1-8b-instant} without notice.
 * Every AI feature in the product — the extension's field fill, the generated answers, the
 * saved-answer learning, fit verdicts, cover letters — routes through {@link AiService}, so the
 * two dead strings took all of them down together, and the only symptom anyone saw was
 * "the extension isn't working". A retired name looks exactly like a healthy one in source, and
 * there is no compiler or linter that can tell the difference. So the names are asserted here.
 *
 * When a model is retired again: check the live catalogue, pick the replacement, and update BOTH
 * the Java default and the yaml default in the same change.
 *   Groq:   curl -H "Authorization: Bearer $KEY" https://api.groq.com/openai/v1/models
 *   Gemini: curl -H "x-goog-api-key: $KEY" https://generativelanguage.googleapis.com/v1beta/models
 */
class AiModelConfigTest {

    /** Names verified dead against the live APIs — they must never come back as a default. */
    private static final List<String> RETIRED = List.of(
            "llama-3.3-70b-versatile", "llama-3.1-8b-instant",
            "llama3-70b-8192", "llama3-8b-8192", "mixtral-8x7b-32768",
            "gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro");

    private static final Path YML = Paths.get("src/main/resources/application.yml");

    @Test
    void javaDefaultsNameNoRetiredModel() {
        JobPilotProperties p = new JobPilotProperties();
        for (String m : List.of(p.getGroq().getModel(), p.getGroq().getFastModel(),
                p.getGemini().getModel(), p.getGemini().getFastModel())) {
            assertFalse(RETIRED.contains(m),
                    "'" + m + "' is a retired model and 404s on every call. "
                    + "Pick a replacement from the provider's live /models listing.");
            assertFalse(m == null || m.isBlank(), "a model default must not be blank");
        }
    }

    @Test
    void yamlDefaultsMatchTheJavaDefaults() throws IOException {
        // The yaml is what actually runs; the Java field is the fallback the self-heal targets.
        // If they drift, the dashboard names one model and the API is sent another.
        String yml = Files.readString(YML);
        JobPilotProperties p = new JobPilotProperties();
        assertEquals(p.getGroq().getModel(), ymlDefault(yml, "JOBPILOT_GROQ_MODEL"));
        assertEquals(p.getGroq().getFastModel(), ymlDefault(yml, "JOBPILOT_GROQ_FAST_MODEL"));
        assertEquals(p.getGemini().getModel(), ymlDefault(yml, "JOBPILOT_GEMINI_MODEL"));
        assertEquals(p.getGemini().getFastModel(), ymlDefault(yml, "JOBPILOT_GEMINI_FAST_MODEL"));
    }

    @Test
    void theSelfHealTargetsAreTheJavaDefaults() {
        // The fall-forward model must be the same one the rest of the app believes it is using,
        // otherwise a healed process quietly runs a model nobody configured.
        JobPilotProperties p = new JobPilotProperties();
        assertEquals(GroqAiClient.DEFAULT_MODEL, p.getGroq().getModel());
        assertEquals(GroqAiClient.DEFAULT_FAST_MODEL, p.getGroq().getFastModel());
        assertEquals(GeminiAiClient.DEFAULT_MODEL, p.getGemini().getModel());
        assertEquals(GeminiAiClient.DEFAULT_FAST_MODEL, p.getGemini().getFastModel());
    }

    @Test
    void geminiUsesTwoDistinctModelsSoTheFreeQuotaIsNotShared() {
        // Each Gemini model name has its own free-tier bucket. Pointing both tiers at one name
        // halves the throughput and is what exhausted 2.5-flash after ~10 calls.
        JobPilotProperties p = new JobPilotProperties();
        assertNotEquals(p.getGemini().getModel(), p.getGemini().getFastModel());
    }

    /** Read the default out of a `${VAR:default}` placeholder in application.yml. */
    private static String ymlDefault(String yml, String var) {
        Matcher m = Pattern.compile(Pattern.quote("${" + var + ":") + "([^}]*)\\}").matcher(yml);
        assertTrue(m.find(), var + " has no ${...} placeholder in application.yml");
        return m.group(1);
    }
}
