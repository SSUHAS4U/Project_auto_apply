package com.jobpilot.web;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.service.BackgroundRunner;
import com.jobpilot.service.CleanupService;
import com.jobpilot.service.DailyService;
import com.jobpilot.service.DigestService;
import com.jobpilot.service.IngestProgress;
import com.jobpilot.service.IngestService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
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
    private final IngestProgress progress;
    private final com.jobpilot.service.MailService mailService;
    private final JobPilotProperties props;
    private final com.jobpilot.service.AtsDiscoveryService discovery;
    private final com.jobpilot.repository.AtsSourceRepository atsSources;

    @Value("${spring.mail.host:}") private String mailHost;
    @Value("${spring.mail.port:}") private String mailPort;
    @Value("${spring.mail.username:}") private String mailUsername;
    @Value("${spring.mail.password:}") private String mailPassword;

    public OpsController(IngestService ingest, DigestService digest, DailyService daily,
                         CleanupService cleanup, BackgroundRunner runner,
                         IngestProgress progress, com.jobpilot.service.MailService mailService,
                         JobPilotProperties props,
                         com.jobpilot.service.AtsDiscoveryService discovery,
                         com.jobpilot.repository.AtsSourceRepository atsSources) {
        this.ingest = ingest;
        this.digest = digest;
        this.daily = daily;
        this.cleanup = cleanup;
        this.runner = runner;
        this.progress = progress;
        this.mailService = mailService;
        this.props = props;
        this.discovery = discovery;
        this.atsSources = atsSources;
    }

    /** Send a test email to verify the mail transport (Brevo/SMTP) is working. Admin-only. */
    @PostMapping("/ops/test-email")
    public Map<String, Object> testEmail(@RequestBody(required = false) Map<String, String> body) {
        String to = body != null && body.get("to") != null && !body.get("to").isBlank()
                ? body.get("to").trim()
                : props.getMail().getDigestTo();
        if (to == null || to.isBlank()) {
            return Map.of("ok", false, "error", "No recipient — set JOBPILOT_MAIL_DIGEST_TO or pass 'to'.");
        }
        try {
            mailService.sendHtml(to, "JobPilot — test email ✓",
                    "<h2>It works 🎉</h2><p>Your JobPilot mail transport is configured correctly. "
                    + "Application emails and digests will send from here.</p>");
            return Map.of("ok", true, "sentTo", to);
        } catch (Exception e) {
            return Map.of("ok", false, "error", e.getMessage());
        }
    }

    /** Detailed live ingest metrics (admin-only via /api/ops): status, log, per-board, memory. */
    @GetMapping("/ops/ingest")
    public Map<String, Object> ingestMetrics() {
        return progress.snapshot();
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

    /** Recompute match scores + region for all jobs (background). */
    @PostMapping("/maintenance/rescore")
    public Map<String, Object> rescore() {
        return runner.startRescore();
    }

    /** Run ATS-board discovery now: health-check boards, drop dead ones, add new ones. */
    @PostMapping("/sources/discover")
    public Map<String, Object> discoverSources() {
        return discovery.discover();
    }

    /** The full board catalogue with health metadata (active, job counts, failures). */
    @GetMapping("/sources")
    public java.util.List<com.jobpilot.domain.AtsSource> listSources() {
        return atsSources.findAll(org.springframework.data.domain.Sort.by("provider", "boardToken"));
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

    /** Wipe the whole job catalogue (keeps tracked jobs). For a fresh re-ingest. */
    @PostMapping("/maintenance/wipe-jobs")
    public Map<String, Object> wipeJobs() {
        return Map.of("deleted", cleanup.wipeJobs());
    }

    /**
     * Diagnostic endpoint to verify mail environment variables are reaching Spring Boot.
     * Token-protected — only accessible with X-Api-Token.
     * Masks the SMTP password for security.
     */
    @GetMapping("/ops/mail-config")
    public Map<String, Object> mailConfig() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("spring.mail.host", mailHost);
        m.put("spring.mail.port", mailPort);
        m.put("spring.mail.username", blankOrSet(mailUsername));
        m.put("spring.mail.password", blankOrSet(mailPassword));
        m.put("jobpilot.mail.from", blankOrSet(props.getMail().getFrom()));
        m.put("jobpilot.mail.digestTo", blankOrSet(props.getMail().getDigestTo()));
        m.put("jobpilot.mail.dailyLimit", props.getMail().getDailyLimit());
        boolean ready = isSet(mailUsername) && isSet(mailPassword)
                && isSet(props.getMail().getFrom()) && isSet(props.getMail().getDigestTo());
        m.put("mailReady", ready);
        if (!ready) {
            m.put("problem", "One or more mail env vars are blank — emails will not send. "
                    + "Set SPRING_MAIL_USERNAME, SPRING_MAIL_PASSWORD, JOBPILOT_MAIL_FROM, JOBPILOT_MAIL_DIGEST_TO in Render.");
        }
        return m;
    }

    private static String blankOrSet(String v) {
        return (v == null || v.isBlank()) ? "*** BLANK / NOT SET ***" : "SET (" + v.length() + " chars)";
    }

    private static boolean isSet(String v) {
        return v != null && !v.isBlank();
    }
}
