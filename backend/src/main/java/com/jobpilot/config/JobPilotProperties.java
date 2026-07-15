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
    /** Email auto-granted ADMIN on register/login (the app owner). */
    private String adminEmail = "ssuhas4u@gmail.com";
    /** Master key for at-rest document encryption (falls back to the JWT secret if blank). */
    private String docKey = "";
    private List<String> corsOrigins = List.of("http://localhost:5173");
    private int ingestConcurrency = 3;
    private String resumeDir = "./uploads";

    private Mail mail = new Mail();
    private Digest digest = new Digest();
    private Schedule schedule = new Schedule();
    private Jwt jwt = new Jwt();

    @Data
    public static class Jwt {
        /** HMAC secret for signing auth tokens. Set a strong value in production. */
        private String secret = "change-me-jobpilot-dev-jwt-secret";
        private long ttlSeconds = 60L * 60 * 24 * 30; // 30 days
    }

    @Data
    public static class Schedule {
        /** Spring cron for the in-app daily run; "-" disables it. */
        private String dailyCron = "-";
        private String zone = "Asia/Kolkata";
        /** Server-side ingest schedule (runs ON the backend — reliable as long as it's awake,
         *  unlike GitHub Actions cron). Default 3x/day at 07:00 / 14:00 / 20:00 IST. "-" disables. */
        private String ingestCron = "0 0 7,14,20 * * *";
        /** UTC times the ingest fires (mirror of the cron) — used to show "next ingest". */
        private String ingestTimesUtc = "01:30,08:30,14:30";
        /** Daily ATS-board discovery (health-check + auto-add new boards); "-" disables. */
        private String discoveryCron = "0 30 6 * * *";
        /** Automated job scout (5x/day default); "-" disables. */
        private String scoutCron = "0 0 8,11,14,17,20 * * *";
        /** Daily Auto Apply run (after the 07:00 ingest); "-" disables the schedule.
         *  The run itself is also gated on the dashboard's pause toggle. */
        private String autoApplyCron = "0 30 9 * * *";
    }
    private CoverLetter coverletter = new CoverLetter();
    private Ai ai = new Ai();
    private Groq groq = new Groq();
    private Ollama ollama = new Ollama();
    private Gemini gemini = new Gemini();
    private Adzuna adzuna = new Adzuna();
    private Jooble jooble = new Jooble();
    private Careerjet careerjet = new Careerjet();
    private IndianApi indianApi = new IndianApi();

    @Data
    public static class Ai {
        /** groq | ollama | gemini | template */
        private String provider = "template";
        /** Optional cap on AI completions per rolling day. 0 (or less) = unlimited.
         *  Groq/Gemini free tiers already rate-limit, so this is off by default. */
        private int dailyLimit = 0;
    }

    @Data
    public static class Groq {
        private String apiKey = "";
        private String model = "llama-3.3-70b-versatile";
        private String fastModel = "llama-3.1-8b-instant";
        private String url = "https://api.groq.com/openai/v1/chat/completions";
        /** Reserved output tokens. Free tier = 6000 TPM, so keep this well under it. */
        private int maxTokens = 4000;
    }

    @Data
    public static class Mail {
        private String from = "";
        private String digestTo = "";
        private int dailyLimit = 25;
        private String brevoApiKey = "";
        private String fromName = "JobPilot";
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
        /** Optional header to authenticate against a secured tunnel (e.g. a Cloudflare
         *  service token or a shared secret), so the public Ollama URL isn't open. */
        private String authHeader = "";
        private String authValue = "";
    }

    @Data
    public static class Gemini {
        private String apiKey = "";
        private String model = "gemini-2.5-flash"; // 1.5-flash was retired (404 on v1beta)
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

    /** Careerjet public search API (free, India locale). Needs an affiliate id (affid). */
    @Data
    public static class Careerjet {
        private String affid = "";
        private String locale = "en_IN";
        private String where = "India";
        private List<String> queries = List.of("software engineer", "java developer", "full stack developer");
    }

    /** IndianAPI.in jobs feed — India-focused aggregator. Needs an x-api-key. */
    @Data
    public static class IndianApi {
        private String apiKey = "";
        private String url = "https://jobs.indianapi.in/jobs";
    }
}
