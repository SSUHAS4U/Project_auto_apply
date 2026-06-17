package com.jobpilot.web;

import com.jobpilot.service.CleanupService;
import com.jobpilot.service.DailyService;
import com.jobpilot.service.DigestService;
import com.jobpilot.service.IngestService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** Cron-only operational endpoints (token protected like the rest of /api). */
@RestController
@RequestMapping("/api")
public class OpsController {

    private final IngestService ingest;
    private final DigestService digest;
    private final DailyService daily;
    private final CleanupService cleanup;

    public OpsController(IngestService ingest, DigestService digest, DailyService daily,
                         CleanupService cleanup) {
        this.ingest = ingest;
        this.digest = digest;
        this.daily = daily;
        this.cleanup = cleanup;
    }

    @PostMapping("/ingest")
    public IngestService.IngestResult ingest() {
        return ingest.run();
    }

    @PostMapping("/digest")
    public Map<String, Object> digest() {
        return digest.run();
    }

    /** One call: fetch latest jobs + AI-curate top picks + notify + digest + purge. */
    @PostMapping("/daily/run")
    public Map<String, Object> daily() {
        return daily.run();
    }

    /** The current AI-curated Daily Picks (separate from the main board). */
    @GetMapping("/daily/picks")
    public Map<String, Object> dailyPicks() {
        return daily.picks();
    }

    /** Manually purge stale jobs (>retention days, untracked). */
    @PostMapping("/maintenance/cleanup")
    public Map<String, Object> cleanup() {
        return Map.of("purged", cleanup.purgeOldJobs());
    }
}
