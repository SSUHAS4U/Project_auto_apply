package com.jobpilot.service.ai;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.*;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The model is chosen in ONE place — Settings → AI model — and every AI feature must obey it.
 *
 * That is an architectural property, not a behaviour any single unit test can pin: it holds only
 * while nothing reaches a provider directly. A service that injected {@code GroqAiClient} instead
 * of {@code AiService} would keep working, keep passing its own tests, and silently ignore the
 * user's preference, the rotation, the rate-limit cooldown and the daily cap — and the only
 * symptom would be "I switched to Gemini but it's still using Groq".
 *
 * So this test reads the source tree and enforces the rule directly.
 */
class AiRoutingGuardTest {

    private static final Path SRC = Paths.get("src/main/java/com/jobpilot");
    /** The only package allowed to touch a provider client directly. */
    private static final Path AI_PACKAGE = SRC.resolve("service/ai");

    private static final List<String> CLIENTS = List.of(
            "GroqAiClient", "GeminiAiClient", "OpenAiCompatAiClient");

    private List<Path> javaFilesOutsideAiPackage() throws IOException {
        try (Stream<Path> s = Files.walk(SRC)) {
            return s.filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> !p.startsWith(AI_PACKAGE))
                    .toList();
        }
    }

    @Test
    void nothingOutsideTheAiPackageTouchesAProviderDirectly() throws IOException {
        List<String> offenders = new ArrayList<>();
        for (Path p : javaFilesOutsideAiPackage()) {
            String body = Files.readString(p);
            for (String client : CLIENTS) {
                if (body.contains(client)) {
                    offenders.add(SRC.relativize(p) + " references " + client);
                }
            }
        }
        assertTrue(offenders.isEmpty(),
                "AI features must go through AiService so the Settings preference, the provider "
                + "rotation and the rate-limit cooldown all apply. Offenders:\n  "
                + String.join("\n  ", offenders));
    }

    @Test
    void everyProviderClientIsReachableThroughTheChain() throws IOException {
        // AiService builds its chain from AUTO_ORDER; a client that is never named there can be
        // configured, look healthy in Settings, and still never be called.
        String svc = Files.readString(AI_PACKAGE.resolve("AiService.java"));
        int start = svc.indexOf("AUTO_ORDER");
        assertTrue(start > 0, "AUTO_ORDER should exist");
        String autoOrder = svc.substring(start, svc.indexOf(';', start));
        for (String name : List.of("gateway", "gemini", "groq")) {
            assertTrue(autoOrder.contains('"' + name + '"'),
                    name + " is not in AUTO_ORDER, so Auto can never select it: " + autoOrder);
        }
    }

    @Test
    void everyClientReportsTheModelItWillUse() throws IOException {
        // Settings shows the model name from the backend. A client that doesn't override model()
        // silently renders as blank, which is how the panel used to hard-code the strings.
        for (String client : CLIENTS) {
            String body = Files.readString(AI_PACKAGE.resolve(client + ".java"));
            assertTrue(body.contains("public String model()"),
                    client + " must override model() so Settings can name it accurately");
        }
    }
}
