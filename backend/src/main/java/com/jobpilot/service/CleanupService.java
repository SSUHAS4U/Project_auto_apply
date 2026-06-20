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
        int stale = jobRepo.deleteStaleUnreferenced(cutoff);
        int nonTech = jobRepo.deleteNonTechUnreferenced();
        int dupes = jobRepo.deleteDuplicates();
        log.info("Cleanup: purged {} stale + {} non-tech + {} duplicate jobs", stale, nonTech, dupes);
        return stale + nonTech + dupes;
    }

    /** Remove duplicate listings (same company+title+city). */
    @Transactional
    public int dedupJobs() {
        return jobRepo.deleteDuplicates();
    }

    /** Wipe the entire job catalogue (keeps jobs the user has tracked/promoted). */
    @Transactional
    public int wipeJobs() {
        int n = jobRepo.deleteAllUnreferenced();
        log.info("Wipe: deleted {} unreferenced jobs", n);
        return n;
    }

    /** Safety-net nightly purge (03:30) even if the daily run didn't fire. */
    @Scheduled(cron = "${jobpilot.cleanup.cron:0 30 3 * * *}", zone = "${jobpilot.schedule.zone:Asia/Kolkata}")
    public void scheduledPurge() {
        purgeOldJobs();
    }
}
