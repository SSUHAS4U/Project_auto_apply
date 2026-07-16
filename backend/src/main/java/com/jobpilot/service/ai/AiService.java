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
    // Gemini first: its free tier (huge TPM/RPD) handles the engine's bursts far better
    // than Groq's 6000 TPM. Groq is the fallback, Ollama last (local only).
    private static final List<String> AUTO_ORDER = List.of("gemini", "groq", "ollama");

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

    /** Remaining AI calls allowed today; -1 when unlimited (no cap configured). */
    public int remainingToday() {
        int limit = props.getAi().getDailyLimit();
        if (limit <= 0) return -1;
        return Math.max(0, limit - usedToday());
    }

    // Small LRU cache so identical requests (same prompt + provider) are free and
    // don't burn the daily quota. Used for deterministic tasks (cover letters, compose,
    // resume parse) — NOT conversational chat.
    private final Map<String, String> cache = java.util.Collections.synchronizedMap(
            new java.util.LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, String> e) {
                    return size() > 300;
                }
            });

    public String complete(String system, String user, boolean fast) {
        return complete(system, user, fast, false);
    }

    /**
     * Run a completion with a provider fallback chain (active → others configured).
     * @param cacheable when true, identical inputs return a cached result for free.
     */
    public String complete(String system, String user, boolean fast, boolean cacheable) {
        String ck = cacheable ? cacheKey(system, user, fast) : null;
        if (ck != null) {
            String hit = cache.get(ck);
            if (hit != null) return hit;
        }
        List<AiClient> chain = fallbackChain();
        if (chain.isEmpty()) {
            throw new IllegalStateException("No AI provider configured. Set a provider + API key in Settings.");
        }
        enforceDailyLimit();
        Exception last = null;
        // Remember each provider's most recent failure so the surfaced error names WHICH
        // provider failed and why (e.g. "gemini: 404 model not found") instead of only the
        // last one in the chain — the difference between a mystery and a one-line fix.
        java.util.LinkedHashMap<String, String> failures = new java.util.LinkedHashMap<>();
        // Two rounds over the whole chain: free tiers throw transient I/O timeouts and
        // 429s all the time — one short backoff usually clears them.
        for (int attempt = 0; attempt < 2; attempt++) {
            for (AiClient c : chain) {
                try {
                    String out = c.complete(system, user, fast);
                    if (out == null || out.isBlank()) throw new IllegalStateException("empty response");
                    increment();
                    if (ck != null) cache.put(ck, out);
                    return out;
                } catch (Exception e) {
                    last = e;
                    String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                    failures.put(c.name(), msg.replaceAll("\\s+", " ").trim());
                    log.warn("AI provider '{}' failed ({}); trying next", c.name(), msg);
                }
            }
            if (attempt == 0 && isTransient(last)) {
                try { Thread.sleep(1500); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            } else break;
        }
        String detail = failures.entrySet().stream()
                .map(en -> en.getKey() + ": " + cap(en.getValue(), 160))
                .reduce((x, y) -> x + " | " + y).orElse("no provider configured");
        throw new IllegalStateException(isTransient(last)
                ? "AI is busy right now — " + detail + ". Try again shortly."
                : "All AI providers failed — " + detail, last);
    }

    private static String cap(String s, int max) {
        return s == null ? "" : (s.length() > max ? s.substring(0, max) + "…" : s);
    }

    /** Rate limits, timeouts and upstream hiccups — worth one retry; real errors aren't. */
    private static boolean isTransient(Exception e) {
        if (e == null) return false;
        String m = e.getMessage() == null ? e.toString() : e.getMessage();
        return java.util.regex.Pattern.compile(
                "timed? ?out|429|413|rate.?limit|too many|too large|payload|tokens per minute|\\btpm\\b"
                        + "|context length|maximum context|i/o error|connection|reset|refused|unavailable"
                        + "|500|502|503|504|overloaded",
                java.util.regex.Pattern.CASE_INSENSITIVE).matcher(m).find();
    }

    /** Active/resolved provider first, then the remaining configured ones (dedup). */
    private List<AiClient> fallbackChain() {
        java.util.LinkedHashSet<AiClient> chain = new java.util.LinkedHashSet<>();
        AiClient primary = resolve();
        if (primary != null && primary.isConfigured()) chain.add(primary);
        for (String n : AUTO_ORDER) {
            // A localhost Ollama is unreachable from a cloud host (Render) — including it in
            // the fallback just turns every rate-limit into a confusing "I/O error on
            // localhost:11434". Skip it unless it's the explicitly chosen provider.
            if ("ollama".equals(n) && isLocalOllama()) continue;
            AiClient c = clients.get(n);
            if (c != null && c.isConfigured()) chain.add(c);
        }
        return new java.util.ArrayList<>(chain);
    }

    private boolean isLocalOllama() {
        String url = props.getOllama().getUrl();
        return url == null || url.contains("localhost") || url.contains("127.0.0.1");
    }

    private String cacheKey(String system, String user, boolean fast) {
        try {
            var md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest((provider() + " " + fast + " " + system + " " + user)
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(d);
        } catch (Exception e) {
            return provider() + ":" + (system + user).hashCode();
        }
    }

    private void enforceDailyLimit() {
        int limit = props.getAi().getDailyLimit();
        if (limit <= 0) return; // unlimited — providers (free Groq/Gemini) self-rate-limit
        if (usedToday() >= limit) {
            throw new IllegalStateException("Daily AI limit reached (" + limit
                    + "). Resets tomorrow — set JOBPILOT_AI_DAILY_LIMIT=0 to disable.");
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
