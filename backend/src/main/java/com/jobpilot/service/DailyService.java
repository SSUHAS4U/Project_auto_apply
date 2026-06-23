package com.jobpilot.service;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.DailyPick;
import com.jobpilot.domain.Job;
import com.jobpilot.repository.DailyPickRepository;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The "daily jobs to apply" pipeline: pull the latest jobs, AI-curate the top new
 * high-match roles into a SEPARATE Daily Picks area (not the main board) for review
 * before applying, send the digest, and purge stale jobs to keep the DB lean.
 *
 * AI does not *fetch* jobs (LLMs can't browse live listings reliably) — connectors
 * fetch; AI ranks/summarizes the best matches for you.
 */
@Service
public class DailyService {

    private static final Logger log = LoggerFactory.getLogger(DailyService.class);

    private static final String SYSTEM = """
            You are a job-hunt assistant. Given today's top matched jobs for the candidate,
            write a short (3-4 sentence) briefing highlighting which 2-3 to prioritise and why,
            referencing titles and companies. Be concrete and encouraging. Plain text only.""";

    private static final String K_BRIEFING = "daily_briefing";
    private static final String K_RUN_AT = "daily_run_at";

    private final IngestService ingest;
    private final JobService jobService;

    private final DailyPickRepository pickRepo;
    private final AiService ai;
    private final NotificationService notifications;
    private final DigestService digest;
    private final CleanupService cleanup;
    private final SettingsService settings;
    private final ProfileService profileService;
    private final JobPilotProperties props;

    public DailyService(IngestService ingest, JobService jobService,
                        DailyPickRepository pickRepo, AiService ai, NotificationService notifications,
                        DigestService digest, CleanupService cleanup, SettingsService settings,
                        ProfileService profileService, JobPilotProperties props) {
        this.ingest = ingest;
        this.jobService = jobService;
        this.pickRepo = pickRepo;
        this.ai = ai;
        this.notifications = notifications;
        this.digest = digest;
        this.cleanup = cleanup;
        this.settings = settings;
        this.profileService = profileService;
        this.props = props;
    }

    @Transactional
    public Map<String, Object> run() {
        IngestService.IngestResult ing = ingest.run();

        int threshold = props.getDigest().getMinScore();
        Instant since = settings.getInstant(K_RUN_AT)
                .orElse(Instant.now().minus(1, ChronoUnit.DAYS));

        List<Job> top = jobService.search(null, null, threshold, null, since, 0, 8).getContent();

        // Replace the Daily Picks set (kept separate from the main board).
        pickRepo.deleteAllInBatch();
        int rank = 1;
        for (Job j : top) {
            DailyPick p = new DailyPick();
            p.setJobId(j.getId());
            p.setRank(rank++);
            pickRepo.save(p);
        }

        String briefing = buildBriefing(top);
        settings.put(K_BRIEFING, briefing);
        settings.setInstant(K_RUN_AT, Instant.now());

        notifications.create("daily",
                "Today's top picks — " + top.size() + " new high matches",
                "Open the Daily Picks tab to review and apply.",
                Map.of("topPicks", top.size(), "ingested", ing.inserted()));

        Map<String, Object> digestResult;
        try {
            digestResult = digest.run();
        } catch (Exception e) {
            log.error("Daily digest email failed: {}", e.getMessage(), e);
            digestResult = Map.of("sent", false, "error", e.getMessage());
        }

        int purged = cleanup.purgeOldJobs();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("fetched", ing.fetched());
        out.put("inserted", ing.inserted());
        out.put("updated", ing.updated());
        out.put("topPicks", top.size());
        out.put("purged", purged);
        out.put("briefing", briefing);
        out.put("digest", digestResult);
        return out;
    }

    /** Daily Picks for the CURRENT user: their top recent high-match jobs + a briefing
     *  addressed to THEM (cached per user + per run so it greets the logged-in user, not the owner). */
    @Transactional(readOnly = true)
    public Map<String, Object> picks() {
        int threshold = Math.max(40, props.getDigest().getMinScore() - 10);
        List<Job> jobs = jobService.search(null, null, threshold, null, null, null, 14, 0, 12).getContent();
        com.jobpilot.domain.Profile me = profileService.get();
        String runAt = settings.getInstant(K_RUN_AT).map(Instant::toString).orElse("none");
        String key = K_BRIEFING + "_" + me.getUserId() + "_" + runAt.replaceAll("[^0-9]", "");
        String briefing = settings.get(key).filter(s -> !s.isBlank())
                .orElseGet(() -> {
                    String b = buildBriefing(jobs.stream().limit(8).toList(), me.getFullName());
                    settings.put(key, b);
                    return b;
                });
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("briefing", briefing);
        out.put("generatedAt", settings.getInstant(K_RUN_AT).map(Instant::toString).orElse(null));
        out.put("jobs", jobs);
        return out;
    }

    private String buildBriefing(List<Job> top) {
        return buildBriefing(top, profileService.getOwner().getFullName());
    }

    private String buildBriefing(List<Job> top, String name) {
        if (top.isEmpty()) {
            return "No new high-match jobs since the last run. Try broadening your skills/queries "
                    + "or adding more company boards.";
        }
        StringBuilder list = new StringBuilder();
        for (Job j : top) {
            list.append("- ").append(j.getTitle()).append(" @ ").append(safe(j.getCompany()))
                    .append(" (").append(safe(j.getLocation())).append(", score ")
                    .append(j.getMatchScore() == null ? "?" : j.getMatchScore()).append(")\n");
        }
        if (!ai.isEnabled()) return "Today's top matches:\n" + list;
        try {
            return ai.complete(SYSTEM, "CANDIDATE: " + (name == null || name.isBlank() ? "there" : name)
                    + "\nTOP MATCHES TODAY:\n" + list, false);
        } catch (Exception e) {
            log.warn("AI briefing failed ({}); using plain list", e.getMessage());
            return "Today's top matches:\n" + list;
        }
    }

    private String safe(String s) {
        return s == null ? "—" : s;
    }
}
