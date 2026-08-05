package com.jobpilot.service.ai;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.service.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
    // Gemini leads on a tie-break of free capacity (larger TPM/RPD than Groq's on-demand
    // tier), but "auto" rotates, so both carry roughly half the load. See fallbackChain().
    private static final List<String> AUTO_ORDER = List.of("gemini", "groq");

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

    /**
     * Per-provider state for the Settings panel: configured, which model it will actually use,
     * whether it is currently in the rotation, and how long it is resting after a rate limit.
     *
     * The model name is read from the client rather than hard-coded in the dashboard, which
     * previously meant changing a model in configuration left the UI naming the old one.
     */
    public List<Map<String, Object>> providerStatus() {
        Instant now = Instant.now();
        List<AiClient> chain = fallbackChain(false);   // read-only: must not spin the rotation
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (String name : List.of("groq", "gemini")) {
            AiClient c = clients.get(name);
            boolean configured = c != null && c.isConfigured();
            Map<String, Object> m = new java.util.LinkedHashMap<>();
            m.put("provider", name);
            m.put("configured", configured);
            m.put("model", configured ? nz(c.model()) : "");
            m.put("inRotation", configured && chain.contains(c));
            m.put("restingSeconds", configured ? restSeconds(name, now) : 0L);
            out.add(m);
        }
        return out;
    }

    private long restSeconds(String name, Instant now) {
        Instant until = coolUntil.get(name);
        if (until == null) return 0L;
        return Math.max(0L, java.time.Duration.between(now, until).toSeconds());
    }

    private static String nz(String s) { return s == null ? "" : s; }

    /**
     * The order providers will be tried in right now — what "Auto" actually means at this
     * moment. Shown in Settings so the rotation is visible rather than a claim.
     */
    public List<String> currentOrder() {
        return fallbackChain(false).stream().map(AiClient::name).toList();
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
        return complete(system, user, fast, cacheable, null);
    }

    /**
     * As above, with an explicit output-token ceiling.
     *
     * Short-JSON callers (the fit/verdict gates) must not reserve a cover-letter-sized budget:
     * free tiers count the reservation against the per-minute limit, so a 4,000-token
     * reservation caps job evaluation at ~3 per minute and 429s the rest. See
     * {@link AiClient#complete(String, String, boolean, Integer)}.
     */
    public String complete(String system, String user, boolean fast, boolean cacheable, Integer maxTokens) {
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
                    String out = c.complete(system, user, fast, maxTokens);
                    if (out == null || out.isBlank()) throw new IllegalStateException("empty response");
                    coolUntil.remove(c.name());   // it answered — it is healthy again
                    increment();
                    if (ck != null) cache.put(ck, out);
                    return out;
                } catch (Exception e) {
                    last = e;
                    noteFailure(c.name(), e);     // rest a rate-limited provider, don't re-hit it
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

    /**
     * How long a provider sits out after telling us it is rate-limited.
     *
     * A saturated provider used to be re-tried as the FIRST choice on every single call: each
     * one paid a full network round-trip to be told 429 before the chain moved on. With a job
     * evaluation every few seconds that is most of the run's latency spent being refused by a
     * provider that already said no.
     */
    private final Map<String, Instant> coolUntil = new ConcurrentHashMap<>();
    /** Rotates the starting provider in "auto" so load is spread, not concentrated. */
    private final AtomicInteger rotation = new AtomicInteger();

    private static final Pattern RATE_LIMITED = Pattern.compile(
            "429|rate.?limit|too many|tokens per minute|\\btpm\\b|\\brpm\\b|quota|resource.?exhausted",
            Pattern.CASE_INSENSITIVE);
    /**
     * Configured but not answering — a provider having an outage or a network fault.
     * Distinct from a rate limit: nothing said
     * "come back later", it simply isn't there.
     */
    private static final Pattern UNREACHABLE = Pattern.compile(
            "connection|connect timed out|refused|unknown host|no route|i/o error|timed? ?out|unavailable|503|502|504",
            Pattern.CASE_INSENSITIVE);
    /** Shorter than a rate-limit rest: an outage may clear at any moment, a quota will not. */
    private static final long UNREACHABLE_REST_SECONDS = 60;
    /** Groq and Gemini both say when to come back: "Please try again in 8.365s". */
    private static final Pattern RETRY_AFTER = Pattern.compile(
            "try again in ([0-9]+(?:\\.[0-9]+)?)\\s*s", Pattern.CASE_INSENSITIVE);

    /**
     * The providers to try, best first.
     *
     * Two changes over "primary, then the rest":
     *
     *  1. **Rotation.** In "auto" every configured provider takes a turn at being first, so two
     *     free tiers give roughly two free tiers of throughput. Fixed ordering meant Groq
     *     absorbed 100% of the load until its 12,000 tokens/minute ran out while a perfectly
     *     healthy Gemini key did nothing — the whole reason job evaluation stalled at a few
     *     verdicts a minute. An explicitly pinned provider still leads; rotation applies to the
     *     rest, because a pin is a deliberate choice and not ours to override.
     *  2. **Cooldown.** A provider that reported a rate limit is moved to the BACK until its
     *     own stated retry time passes. It is never removed — if everything is cooling we would
     *     rather ask and be refused than refuse on its behalf.
     */
    private List<AiClient> fallbackChain() { return fallbackChain(true); }

    /**
     * @param advance whether to move the rotation on. The Settings panel polls this to SHOW the
     *        order; letting a read spin the counter would mean the split depended on how often
     *        someone had the page open.
     */
    private List<AiClient> fallbackChain(boolean advance) {
        String p = provider();
        boolean auto = "auto".equals(p) || resolve() == null;

        List<AiClient> chain = new java.util.ArrayList<>();
        if (!auto) {
            AiClient pinned = clients.get(p);
            if (pinned != null && pinned.isConfigured()) chain.add(pinned);
        }

        List<AiClient> pool = new java.util.ArrayList<>();
        for (String n : AUTO_ORDER) {
            AiClient c = clients.get(n);
            if (c != null && c.isConfigured() && !chain.contains(c)) pool.add(c);
        }
        if (pool.size() > 1) {
            int turn = advance ? rotation.getAndIncrement() : rotation.get();
            java.util.Collections.rotate(pool, -Math.floorMod(turn, pool.size()));
        }
        chain.addAll(pool);

        // Stable sort: cooling providers go last, and the rotation order survives within each
        // group. Boolean.compare puts false (healthy) before true (cooling).
        Instant now = Instant.now();
        chain.sort(java.util.Comparator.comparing(c -> isCooling(c.name(), now)));
        return chain;
    }

    private boolean isCooling(String name, Instant now) {
        Instant until = coolUntil.get(name);
        if (until == null) return false;
        if (now.isBefore(until)) return true;
        coolUntil.remove(name);          // expired — healthy again
        return false;
    }

    /**
     * Record a rate-limit so this provider is skipped until it says it is ready. Anything that
     * is not a rate limit is left alone: a 404 or a bad key is the chain's problem to surface,
     * not something to paper over with a timer.
     */
    private void noteFailure(String name, Exception e) {
        String m = e.getMessage() == null ? e.toString() : e.getMessage();
        long secs;
        String why;
        if (RATE_LIMITED.matcher(m).find()) {
            secs = 30;
            Matcher hint = RETRY_AFTER.matcher(m);
            if (hint.find()) {
                try { secs = (long) Math.ceil(Double.parseDouble(hint.group(1))) + 1; } catch (NumberFormatException ignored) { }
            }
            secs = Math.max(5, Math.min(secs, 120));
            why = "rate-limited";
        } else if (UNREACHABLE.matcher(m).find()) {
            // A provider that is down would otherwise be re-dialled at the head of the chain
            // on every single call, paying a connection timeout each time before falling
            // through. Rest it briefly instead, and let a success bring it straight back.
            secs = UNREACHABLE_REST_SECONDS;
            why = "unreachable";
        } else {
            return;   // a real fault (401, 404, bad model) must surface, not hide behind a timer
        }
        coolUntil.put(name, Instant.now().plusSeconds(secs));
        log.info("AI provider '{}' is {}; resting it for {}s", name, why, secs);
    }

    /** Which providers are currently resting, and for how long — surfaced in Settings. */
    public Map<String, Long> coolingProviders() {
        Instant now = Instant.now();
        Map<String, Long> out = new java.util.LinkedHashMap<>();
        coolUntil.forEach((name, until) -> {
            long left = java.time.Duration.between(now, until).toSeconds();
            if (left > 0) out.put(name, left);
        });
        return out;
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
