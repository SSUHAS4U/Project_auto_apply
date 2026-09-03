package com.jobpilot.service.ai;

/** A chat-completion backend (Groq or Gemini). */
public interface AiClient {
    /** provider key: groq | gemini */
    String name();

    boolean isConfigured();

    /**
     * The model this provider will actually use, for display. The Settings UI used to hard-code
     * these strings ("llama-3.3-70b", "gemini-2.5-flash"), so changing a model in configuration
     * left the dashboard confidently naming the wrong one.
     */
    default String model() { return ""; }

    /**
     * Single-turn completion.
     * @param fast prefer a smaller/cheaper/faster model when the provider has one.
     */
    String complete(String system, String user, boolean fast);

    /**
     * Single-turn completion with an explicit output budget.
     *
     * This exists because Groq's free tier used to bill the RESERVATION, not the usage: it
     * allowed 12,000 tokens per minute and counted `max_tokens` against it in full, so the
     * configured 4,000 (sized for cover letters) made a one-line JSON verdict cost a third of
     * the whole minute and 429'd everything after the third evaluation —
     *   "Limit 12000, Used 9139, Requested 4534"
     *
     * Re-measured 2026-09-03 against the current tier (8,000 TPM): a max_tokens of 6,000 moved
     * x-ratelimit-remaining-tokens by ~150, i.e. by what the call USED. The reservation is no
     * longer charged. The ceiling is kept anyway — it still bounds a runaway answer, and it is
     * what keeps a reasoning model's hidden thinking in proportion to the task.
     *
     * @param maxTokens output ceiling, or null for the provider's configured default.
     */
    default String complete(String system, String user, boolean fast, Integer maxTokens) {
        return complete(system, user, fast);
    }
}
