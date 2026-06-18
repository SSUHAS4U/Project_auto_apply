package com.jobpilot.service.ai;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.service.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Central entry point for all LLM calls. Selects the configured provider and
 * enforces a hard per-day completion cap (cost guardrail) so nothing runs away.
 */
@Service
public class AiService {

    private static final Logger log = LoggerFactory.getLogger(AiService.class);

    private final Map<String, AiClient> clients;
    private final JobPilotProperties props;
    private final SettingsService settings;

    public AiService(List<AiClient> clientList, JobPilotProperties props, SettingsService settings) {
        this.clients = clientList.stream().collect(Collectors.toMap(AiClient::name, Function.identity()));
        this.props = props;
        this.settings = settings;
    }

    private static final String K_PROVIDER = "ai_provider";
    private static final List<String> AUTO_ORDER = List.of("groq", "gemini", "ollama");

    /** Configured provider — settings override the .env default; "auto" resolves at call time. */
    public String provider() {
        return settings.get(K_PROVIDER).filter(s -> !s.isBlank())
                .orElse(props.getAi().getProvider());
    }

    public void setProvider(String name) {
        settings.put(K_PROVIDER, name == null ? "auto" : name.trim().toLowerCase());
    }

    /** Resolve "auto" to the first configured client; otherwise the named one. */
    private AiClient resolve() {
        String p = provider();
        if ("auto".equals(p)) {
            return AUTO_ORDER.stream().map(clients::get)
                    .filter(c -> c != null && c.isConfigured()).findFirst().orElse(null);
        }
        return clients.get(p);
    }

    public boolean isEnabled() {
        AiClient c = resolve();
        return c != null && c.isConfigured();
    }

    /** Per-provider configured + reachable status (for the Settings test panel). */
    public List<Map<String, Object>> providerStatus() {
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (String name : List.of("groq", "gemini", "ollama")) {
            AiClient c = clients.get(name);
            out.add(Map.of("provider", name, "configured", c != null && c.isConfigured()));
        }
        return out;
    }

    /** Live test: run a 1-token completion against a specific provider. */
    public Map<String, Object> test(String name) {
        AiClient c = clients.get(name);
        if (c == null) return Map.of("provider", name, "ok", false, "error", "unknown provider");
        if (!c.isConfigured()) return Map.of("provider", name, "ok", false, "error", "not configured (missing key)");
        try {
            long t0 = System.currentTimeMillis();
            String r = c.complete("You are a test.", "Reply with the single word: ok", true);
            return Map.of("provider", name, "ok", true,
                    "ms", System.currentTimeMillis() - t0, "sample", r.length() > 40 ? r.substring(0, 40) : r);
        } catch (Exception e) {
            return Map.of("provider", name, "ok", false, "error", e.getMessage());
        }
    }

    /** Remaining AI calls allowed today. */
    public int remainingToday() {
        return Math.max(0, props.getAi().getDailyLimit() - usedToday());
    }

    /** Run a completion through the active provider, counting it against the daily cap. */
    public String complete(String system, String user, boolean fast) {
        AiClient client = resolve();
        if (client == null || !client.isConfigured()) {
            throw new IllegalStateException("AI provider '" + provider()
                    + "' is not configured. Set a provider + API key (Settings) or JOBPILOT_AI_PROVIDER.");
        }
        enforceDailyLimit();
        try {
            String out = client.complete(system, user, fast);
            increment();
            return out;
        } catch (Exception e) {
            log.warn("AI completion failed ({}): {}", client.name(), e.getMessage());
            throw new IllegalStateException("AI request failed: " + e.getMessage(), e);
        }
    }

    private void enforceDailyLimit() {
        int used = usedToday();
        if (used >= props.getAi().getDailyLimit()) {
            throw new IllegalStateException("Daily AI limit reached (" + props.getAi().getDailyLimit()
                    + "). Resets tomorrow — adjust JOBPILOT_AI_DAILY_LIMIT to change.");
        }
    }

    private int usedToday() {
        return settings.get(key()).map(Integer::parseInt).orElse(0);
    }

    private void increment() {
        settings.put(key(), String.valueOf(usedToday() + 1));
    }

    private String key() {
        return "ai_usage_" + LocalDate.now(ZoneOffset.UTC);
    }
}
