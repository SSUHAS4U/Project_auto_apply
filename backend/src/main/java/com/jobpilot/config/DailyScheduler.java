package com.jobpilot.config;

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

    public DailyScheduler(DailyService daily, BackgroundRunner runner) {
        this.daily = daily;
        this.runner = runner;
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
