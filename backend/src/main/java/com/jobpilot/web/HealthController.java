package com.jobpilot.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

@RestController
public class HealthController {

    /** Public, unauthenticated liveness probe (outside /api). */
    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of("status", "ok", "service", "jobpilot", "time", Instant.now().toString());
    }

    /** Token-protected probe the dashboard uses to confirm its token works. */
    @GetMapping("/api/health")
    public Map<String, Object> securedHealth() {
        return Map.of("status", "ok", "authenticated", true, "time", Instant.now().toString());
    }
}
