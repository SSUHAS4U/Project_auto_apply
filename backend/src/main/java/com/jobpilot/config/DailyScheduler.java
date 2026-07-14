package com.jobpilot.config;

import com.jobpilot.service.AtsDiscoveryService;
import com.jobpilot.service.BackgroundRunner;
import com.jobpilot.service.DailyService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * In-app schedulers. These fire ON the backend (not via GitHub), so they're reliable as
 * long as the instance is awake (the keep-alive ping handles that on Render free tier).
 *
 * - runIngest: refreshes jobs 3x/day (default 07:00 / 14:00 / 20:00 IST). This is the
 *   PRIMARY ingest trigger — GitHub Actions cron is only a backup since it's unreliable.
 * - runDaily: the full daily pipeline; off by default ("-"), opt-in via JOBPILOT_DAILY_CRON.
 */
@Component
public class DailyScheduler {

    private static final Logger log = LoggerFactory.getLogger(DailyScheduler.class);
    private final DailyService daily;
    private final BackgroundRunner runner;
    private final AtsDiscoveryService discovery;
    private final com.jobpilot.service.JobScoutService scout;
    private final com.jobpilot.pilot.PilotOrchestrator pilot;

    public DailyScheduler(DailyService daily, BackgroundRunner runner,
                          AtsDiscoveryService discovery, com.jobpilot.service.JobScoutService scout,
                          com.jobpilot.pilot.PilotOrchestrator pilot) {
        this.daily = daily;
        this.runner = runner;
        this.discovery = discovery;
        this.scout = scout;
        this.pilot = pilot;
    }

    /** Daily Pilot cycle — evaluate → draft → review → compile → verify → apply.
     *  The orchestrator no-ops when the dashboard pause toggle is off. */
    @Scheduled(cron = "${jobpilot.schedule.auto-apply-cron:0 30 9 * * *}", zone = "${jobpilot.schedule.zone:Asia/Kolkata}")
    public void runPilot() {
        log.info("Scheduled pilot cycle starting…");
        try {
            pilot.run("scheduled");
        } catch (Exception e) {
            log.warn("Scheduled pilot cycle failed: {}", e.getMessage());
        }
    }

    /** Automated job scout — 5x/day by default; fills the dashboard's Scout section. */
    @Scheduled(cron = "${jobpilot.schedule.scout-cron:0 0 8,11,14,17,20 * * *}", zone = "${jobpilot.schedule.zone:Asia/Kolkata}")
    public void runScout() {
        log.info("Scheduled scout run starting…");
        try {
            scout.run();
        } catch (Exception e) {
            log.warn("Scheduled scout run failed: {}", e.getMessage());
        }
    }

    /**
     * Daily source discovery: health-check every ATS board, drop dead ones, and add
     * newly found boards — runs before the first ingest so fresh boards are included.
     */
    @Scheduled(cron = "${jobpilot.schedule.discovery-cron:0 30 6 * * *}", zone = "${jobpilot.schedule.zone:Asia/Kolkata}")
    public void runDiscovery() {
        log.info("Scheduled source discovery starting…");
        try {
            discovery.discover();
        } catch (Exception e) {
            log.warn("Scheduled source discovery failed: {}", e.getMessage());
        }
    }

    /** Reliable server-side ingest (3x/day by default). Uses the background runner's
     *  one-at-a-time guard, so it never collides with a manual or GitHub-triggered run. */
    @Scheduled(cron = "${jobpilot.schedule.ingest-cron:-}", zone = "${jobpilot.schedule.zone:Asia/Kolkata}")
    public void runIngest() {
        log.info("Scheduled ingest starting…");
        try {
            runner.startIngest();
        } catch (Exception e) {
            log.warn("Scheduled ingest failed: {}", e.getMessage());
        }
    }

    @Scheduled(cron = "${jobpilot.schedule.daily-cron:-}", zone = "${jobpilot.schedule.zone:Asia/Kolkata}")
    public void runDaily() {
        log.info("Scheduled daily run starting…");
        try {
            daily.run();
        } catch (Exception e) {
            log.warn("Scheduled daily run failed: {}", e.getMessage());
        }
    }
}
