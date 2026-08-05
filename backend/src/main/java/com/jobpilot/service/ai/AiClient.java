package com.jobpilot.service.ai;

/** A chat-completion backend (Groq, Ollama, Gemini). */
public interface AiClient {
    /** provider key: groq | ollama | gemini */
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
     * This exists because free tiers bill the RESERVATION, not the usage. Groq's on-demand tier
     * allows 12,000 tokens per minute and counts `max_tokens` against it in full: with the
     * configured 4,000 (sized for cover letters) a one-line JSON verdict costs a third of the
     * whole minute's budget, so roughly three job evaluations per minute succeed and everything
     * after that is a 429. Measured against the live API:
     *   "Limit 12000, Used 9139, Requested 4534"
     * The verdict callers ask for a few hundred tokens instead, which is what they actually use.
     *
     * @param maxTokens output ceiling, or null for the provider's configured default.
     */
    default String complete(String system, String user, boolean fast, Integer maxTokens) {
        return complete(system, user, fast);
    }
}
