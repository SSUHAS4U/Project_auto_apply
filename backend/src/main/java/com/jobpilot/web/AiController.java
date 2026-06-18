package com.jobpilot.web;

import com.jobpilot.service.AssistantService;
import com.jobpilot.service.ai.AiService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class AiController {

    private static final String SUGGEST_SYSTEM = """
            You help a job seeker write a single form field. Given the field name and what they
            have typed so far, return ONLY the improved/completed value for that field — concise,
            professional, first person, no quotes, no explanation, no markdown.""";

    private final AiService ai;
    private final AssistantService assistant;

    public AiController(AiService ai, AssistantService assistant) {
        this.ai = ai;
        this.assistant = assistant;
    }

    /** Lightweight status the dashboard uses to enable/disable AI features. */
    @GetMapping("/ai/status")
    public Map<String, Object> status() {
        return Map.of("enabled", ai.isEnabled(), "provider", ai.provider(),
                "remainingToday", ai.remainingToday(), "providers", ai.providerStatus());
    }

    /** Switch the active AI model: groq | gemini | ollama | auto. */
    @PostMapping("/ai/provider")
    public Map<String, Object> setProvider(@RequestBody Map<String, String> body) {
        ai.setProvider(body.get("provider"));
        return Map.of("provider", ai.provider(), "enabled", ai.isEnabled());
    }

    /** Live test a specific provider's connection. */
    @PostMapping("/ai/test")
    public Map<String, Object> test(@RequestBody Map<String, String> body) {
        return ai.test(body.getOrDefault("provider", ai.provider()));
    }

    /** On-demand field suggestion (uses the fast/cheap model). */
    @PostMapping("/ai/suggest")
    public Map<String, Object> suggest(@RequestBody Map<String, String> body) {
        String field = body.getOrDefault("field", "this field");
        String current = body.getOrDefault("text", "");
        String context = body.getOrDefault("context", "");
        String prompt = "FIELD: " + field + "\nCONTEXT: " + context + "\nTYPED SO FAR: " + current;
        return Map.of("suggestion", ai.complete(SUGGEST_SYSTEM, prompt, true));
    }

    /** Conversational assistant (profile help + find jobs by summary). */
    @PostMapping("/assistant/chat")
    public Map<String, Object> chat(@RequestBody Map<String, Object> body) {
        @SuppressWarnings("unchecked")
        List<Map<String, String>> messages = (List<Map<String, String>>) body.get("messages");
        return assistant.chat(messages);
    }
}
