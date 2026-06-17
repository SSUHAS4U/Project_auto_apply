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

    public boolean isEnabled() {
        AiClient c = clients.get(props.getAi().getProvider());
        return c != null && c.isConfigured();
    }

    public String provider() {
        return props.getAi().getProvider();
    }

    /** Remaining AI calls allowed today. */
    public int remainingToday() {
        return Math.max(0, props.getAi().getDailyLimit() - usedToday());
    }

    /** Run a completion through the active provider, counting it against the daily cap. */
    public String complete(String system, String user, boolean fast) {
        AiClient client = clients.get(props.getAi().getProvider());
        if (client == null || !client.isConfigured()) {
            throw new IllegalStateException("AI provider '" + props.getAi().getProvider()
                    + "' is not configured. Set JOBPILOT_AI_PROVIDER + its API key.");
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
