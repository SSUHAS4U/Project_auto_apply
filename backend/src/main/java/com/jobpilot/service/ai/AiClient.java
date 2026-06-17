package com.jobpilot.service.ai;

/** A chat-completion backend (Groq, Ollama, Gemini). */
public interface AiClient {
    /** provider key: groq | ollama | gemini */
    String name();

    boolean isConfigured();

    /**
     * Single-turn completion.
     * @param fast prefer a smaller/cheaper/faster model when the provider has one.
     */
    String complete(String system, String user, boolean fast);
}
