package com.jobpilot.service;

import com.jobpilot.repository.JobRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

/**
 * Keeps the DB lean: deletes jobs older than the retention window that the user
 * has NOT acted on (no tracked application, not promoted from a saved listing).
 */
@Service
public class CleanupService {

    private static final Logger log = LoggerFactory.getLogger(CleanupService.class);

    private final JobRepository jobRepo;
    private final int retentionDays;

    public CleanupService(JobRepository jobRepo,
                          @Value("${jobpilot.cleanup.retention-days:7}") int retentionDays) {
        this.jobRepo = jobRepo;
        this.retentionDays = retentionDays;
    }

    @Transactional
    public int purgeOldJobs() {
        Instant cutoff = Instant.now().minus(retentionDays, ChronoUnit.DAYS);
        int deleted = jobRepo.deleteStaleUnreferenced(cutoff);
        log.info("Cleanup: purged {} stale jobs older than {} days", deleted, retentionDays);
        return deleted;
    }

    /** Safety-net nightly purge (03:30) even if the daily run didn't fire. */
    @Scheduled(cron = "${jobpilot.cleanup.cron:0 30 3 * * *}", zone = "${jobpilot.schedule.zone:Asia/Kolkata}")
    public void scheduledPurge() {
        purgeOldJobs();
    }
}
