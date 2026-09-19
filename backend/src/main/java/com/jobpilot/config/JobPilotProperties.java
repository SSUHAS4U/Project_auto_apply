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
    /**
     * Master key for at-rest document encryption.
     *
     * Falls back to the JWT secret when blank, which is why rotating the JWT secret WITHOUT
     * setting this first makes every stored document permanently undecryptable. Production
     * requires it explicitly — see {@link com.jobpilot.security.DocumentCrypto}.
     */
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
        /**
         * HMAC secret for signing auth tokens.
         *
         * Empty by default ON PURPOSE — a published default IS the vulnerability, and this
         * repository is public. Unset means a random per-process key locally and a refusal to
         * start in production. See {@link com.jobpilot.security.JwtSecretResolver}.
         */
        private String secret = "";
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
    private Gemini gemini = new Gemini();
    private Careerjet careerjet = new Careerjet();
    private IndianApi indianApi = new IndianApi();
    private Jooble jooble = new Jooble();

    @Data
    public static class Ai {
        /** groq | gemini | template */
        private String provider = "template";
        /** Optional cap on AI completions per rolling day. 0 (or less) = unlimited.
         *  Groq/Gemini free tiers already rate-limit, so this is off by default. */
        private int dailyLimit = 0;
    }

    @Data
    public static class Groq {
        private String apiKey = "";
        /** Both llama defaults were retired by Groq (404 model_not_found) — see the groq client. */
        private String model = "openai/gpt-oss-120b";
        private String fastModel = "openai/gpt-oss-20b";
        private String url = "https://api.groq.com/openai/v1/chat/completions";
        /** Output ceiling per answer. Measured free tier = 8000 TPM per model, billed on use. */
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
        /** gemini | template */
        private String provider = "template";
    }

    @Data
    public static class Gemini {
        private String apiKey = "";
        /** 2.5-flash still resolves, but its free-tier bucket is exhausted in ~10 calls. */
        private String model = "gemini-3.5-flash";
        /** A separate model name means a separate free quota bucket — see the gemini client. */
        private String fastModel = "gemini-3.1-flash-lite";
        /** Overridable so the decommission self-heal can be tested against a local stub. */
        private String baseUrl = "https://generativelanguage.googleapis.com/v1beta/models/";
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

    /**
     * Jooble search API — free key, POSTed to https://jooble.org/api/{key}.
     *
     * Note what it is and is not. Jooble returns `link` as a jooble.org/jdp/… redirect, never
     * a direct posting URL, and its `source` field names the board a listing really came from
     * (decentrajobs.com, jobs.dish.com, ceipal.com …). It is a volume source with an origin
     * label — it is NOT a route to Naukri/Indeed/LinkedIn postings, whatever the old Scout
     * comment claimed. Verified against the live API on 2026-09-19.
     */
    @Data
    public static class Jooble {
        private String key = "";
        private String where = "India";
        private List<String> keywords = List.of();
    }
}
