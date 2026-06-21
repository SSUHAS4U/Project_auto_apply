package com.jobpilot.web;

import com.jobpilot.service.IngestProgress;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Lightweight, non-admin metrics. Any logged-in user can see the last-ingest
 * summary (when it ran, how many new vs. unchanged) shown atop the Jobs board.
 * The detailed live log + memory lives under /api/ops (admin only).
 */
@RestController
@RequestMapping("/api/metrics")
public class MetricsController {

    private final IngestProgress progress;

    public MetricsController(IngestProgress progress) {
        this.progress = progress;
    }

    @GetMapping("/ingest")
    public Map<String, Object> ingestSummary() {
        return progress.summary();
    }
}
