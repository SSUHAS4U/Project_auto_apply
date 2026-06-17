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
    private CoverLetter coverletter = new CoverLetter();
    private Ollama ollama = new Ollama();
    private Gemini gemini = new Gemini();
    private Adzuna adzuna = new Adzuna();
    private Jooble jooble = new Jooble();

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
