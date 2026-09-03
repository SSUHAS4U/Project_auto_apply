package com.jobpilot.service.ai;

import java.util.Set;

/**
 * Model names that are verified dead, so the app never sends one.
 *
 * The provider clients already recover from a retirement they meet at runtime: they take the
 * 404, fall forward to the verified default, and remember it. That handles the retirement nobody
 * saw coming. It does not handle the one we already know about, and the difference matters:
 *
 *  - the first call after every restart is still spent being told 404, per model, forever;
 *  - and until that call happens the Settings panel confidently displays a model that does not
 *    exist, because the panel reads the configured name.
 *
 * Both because the model names live in a {@code .env} on the deployment VM, where the repo's
 * defaults cannot reach them, and a config file on a server is not something anyone edits
 * without a reason to suspect it.
 *
 * So a name known to be gone is skipped before the request is built. The configured value is
 * ignored rather than obeyed — the one case where overriding the operator is right, because the
 * alternative is a guaranteed failure.
 *
 * <p><b>Adding to this list is a factual claim, not a preference.</b> A name belongs here only
 * after the live catalogue has been checked and the model is actually absent:
 * <pre>
 *   curl -H "Authorization: Bearer $KEY" https://api.groq.com/openai/v1/models
 *   curl -H "x-goog-api-key: $KEY" https://generativelanguage.googleapis.com/v1beta/models
 * </pre>
 * A model that is merely rate-limited, expensive or disliked must NOT be listed: it still works,
 * and pinning it is the operator's call to make.
 */
final class RetiredModels {

    private RetiredModels() { }

    /**
     * Verified absent from the providers' live catalogues on 2026-09-03.
     *
     * The two llama entries are the ones that took every AI feature in the product down at once
     * — field fill, generated answers, saved-answer learning, fit verdicts and cover letters all
     * route through AiService, so a single dead string broke them together and arrived as three
     * separate bug reports.
     */
    private static final Set<String> GONE = Set.of(
            // Groq — removed from the catalogue, not deprecated. 404 model_not_found.
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            "llama-3.1-70b-versatile",
            "llama3-70b-8192",
            "llama3-8b-8192",
            "mixtral-8x7b-32768",
            "gemma2-9b-it",
            // Gemini — retired from v1beta.
            "gemini-1.5-flash",
            "gemini-1.5-flash-latest",
            "gemini-1.5-pro",
            "gemini-1.5-pro-latest",
            "gemini-pro",
            "gemini-1.0-pro");

    /** True when this name is known to 404 and must not be sent. */
    static boolean isRetired(String model) {
        return model != null && GONE.contains(model.trim());
    }

    /** The whole list, for the config guard that keeps a retired name out of the defaults. */
    static Set<String> all() {
        return GONE;
    }
}
