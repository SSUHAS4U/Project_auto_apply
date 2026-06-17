package com.jobpilot.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

import java.util.List;

/** Strongly-typed binding of all {@code jobpilot.*} settings. */
@Data
@Component
@ConfigurationProperties(prefix = "jobpilot")
public class JobPilotProperties {

    private String apiToken = "dev-token";
    private List<String> corsOrigins = List.of("http://localhost:5173");
    private String resumeDir = "./uploads";

    private Mail mail = new Mail();
    private Digest digest = new Digest();
    private Schedule schedule = new Schedule();

    @Data
    public static class Schedule {
        /** Spring cron for the in-app daily run; "-" disables it. */
        private String dailyCron = "-";
        private String zone = "Asia/Kolkata";
    }
    private CoverLetter coverletter = new CoverLetter();
    private Ai ai = new Ai();
    private Groq groq = new Groq();
    private Ollama ollama = new Ollama();
    private Gemini gemini = new Gemini();
    private Adzuna adzuna = new Adzuna();
    private Jooble jooble = new Jooble();
    private GoogleCse googleCse = new GoogleCse();

    @Data
    public static class GoogleCse {
        /** Google Custom Search JSON API key (free, 100 queries/day). */
        private String apiKey = "";
        /** Programmable Search Engine id (cx). */
        private String cx = "";
        /** Search queries; results are treated as url-apply jobs. */
        private List<String> queries = List.of();
    }

    @Data
    public static class Ai {
        /** groq | ollama | gemini | template */
        private String provider = "template";
        /** Hard cap on AI completions per rolling day (cost guardrail). */
        private int dailyLimit = 80;
    }

    @Data
    public static class Groq {
        private String apiKey = "";
        private String model = "llama-3.3-70b-versatile";
        private String fastModel = "llama-3.1-8b-instant";
        private String url = "https://api.groq.com/openai/v1/chat/completions";
    }

    @Data
    public static class Mail {
        private String from = "";
        private String digestTo = "";
        private int dailyLimit = 25;
    }

    @Data
    public static class Digest {
        private int minScore = 60;
    }

    @Data
    public static class CoverLetter {
        /** ollama | gemini | template */
        private String provider = "template";
    }

    @Data
    public static class Ollama {
        private String url = "http://localhost:11434";
        private String model = "llama3.1";
    }

    @Data
    public static class Gemini {
        private String apiKey = "";
        private String model = "gemini-1.5-flash";
    }

    @Data
    public static class Adzuna {
        private String appId = "";
        private String appKey = "";
        private String country = "in";
        private String where = "India";
        /** comma-separated search queries */
        private List<String> queries = List.of();
    }

    @Data
    public static class Jooble {
        private String key = "";
        private String keywords = "java developer";
    }
}
