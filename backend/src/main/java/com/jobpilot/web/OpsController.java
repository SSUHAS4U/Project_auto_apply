package com.jobpilot.web;

import com.jobpilot.service.BackgroundRunner;
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
    private final BackgroundRunner runner;

    public OpsController(IngestService ingest, DigestService digest, DailyService daily,
                         CleanupService cleanup, BackgroundRunner runner) {
        this.ingest = ingest;
        this.digest = digest;
        this.daily = daily;
        this.cleanup = cleanup;
        this.runner = runner;
    }

    /** Kick off ingest in the background (returns immediately). */
    @PostMapping("/ingest")
    public Map<String, Object> ingest() {
        return runner.startIngest();
    }

    /** Synchronous ingest (waits for the result) — for cron/scripts. */
    @PostMapping("/ingest/sync")
    public IngestService.IngestResult ingestSync() {
        return ingest.run();
    }

    @PostMapping("/digest")
    public Map<String, Object> digest() {
        return digest.run();
    }

    /** Kick off the daily pipeline in the background (returns immediately). */
    @PostMapping("/daily/run")
    public Map<String, Object> daily() {
        return runner.startDaily();
    }

    /** Synchronous daily run (waits) — for cron/scripts. */
    @PostMapping("/daily/run/sync")
    public Map<String, Object> dailySync() {
        return daily.run();
    }

    @GetMapping("/ops/status")
    public Map<String, Object> opsStatus() {
        return runner.status();
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
