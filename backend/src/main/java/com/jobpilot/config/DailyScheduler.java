package com.jobpilot.config;

import com.jobpilot.service.DailyService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * In-app daily run. Only fires while the app is running, so it's optional and
 * disabled by default ("-"). For an always-on schedule on a sleeping free host,
 * use the GitHub Actions cron or Windows Task Scheduler instead (see scripts/).
 *
 * Enable by setting JOBPILOT_DAILY_CRON, e.g. "0 0 8 * * *" (08:00 daily).
 */
@Component
public class DailyScheduler {

    private static final Logger log = LoggerFactory.getLogger(DailyScheduler.class);
    private final DailyService daily;

    public DailyScheduler(DailyService daily) {
        this.daily = daily;
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
