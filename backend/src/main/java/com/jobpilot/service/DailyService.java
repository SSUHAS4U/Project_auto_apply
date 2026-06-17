package com.jobpilot.service;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.Job;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

/**
 * The "daily jobs to apply" pipeline: pull the latest jobs from every connector,
 * then use AI to curate the top new high-match roles into a notification (and the
 * digest email). Run on a schedule or on demand via POST /api/daily/run.
 *
 * NOTE: AI does not *fetch* jobs (LLMs can't browse live listings reliably) — the
 * connectors fetch; AI ranks/summarizes the best matches for you.
 */
@Service
public class DailyService {

    private static final Logger log = LoggerFactory.getLogger(DailyService.class);

    private static final String SYSTEM = """
            You are a job-hunt assistant. Given today's top matched jobs for the candidate,
            write a short (3-4 sentence) briefing highlighting which 2-3 to prioritise and why,
            referencing titles and companies. Be concrete and encouraging. Plain text only.""";

    private final IngestService ingest;
    private final JobService jobService;
    private final AiService ai;
    private final NotificationService notifications;
    private final DigestService digest;
    private final SettingsService settings;
    private final ProfileService profileService;
    private final JobPilotProperties props;

    public DailyService(IngestService ingest, JobService jobService, AiService ai,
                        NotificationService notifications, DigestService digest,
                        SettingsService settings, ProfileService profileService,
                        JobPilotProperties props) {
        this.ingest = ingest;
        this.jobService = jobService;
        this.ai = ai;
        this.notifications = notifications;
        this.digest = digest;
        this.settings = settings;
        this.profileService = profileService;
        this.props = props;
    }

    public Map<String, Object> run() {
        IngestService.IngestResult ing = ingest.run();

        int threshold = props.getDigest().getMinScore();
        Instant since = settings.getInstant("last_daily_at")
                .orElse(Instant.now().minus(1, ChronoUnit.DAYS));

        List<Job> top = jobService
                .search(null, null, threshold, null, since, 0, 8)
                .getContent();

        String briefing = buildBriefing(top);
        notifications.create("daily",
                "Today's top picks — " + top.size() + " new high matches",
                briefing,
                Map.of("jobIds", top.stream().map(j -> j.getId().toString()).toList(),
                        "ingested", ing.inserted()));

        // Also send the digest email (best-effort).
        Map<String, Object> digestResult;
        try {
            digestResult = digest.run();
        } catch (Exception e) {
            log.warn("Daily digest email failed: {}", e.getMessage());
            digestResult = Map.of("sent", false, "error", e.getMessage());
        }

        settings.setInstant("last_daily_at", Instant.now());

        Map<String, Object> out = new java.util.HashMap<>();
        out.put("fetched", ing.fetched());
        out.put("inserted", ing.inserted());
        out.put("updated", ing.updated());
        out.put("topPicks", top.size());
        out.put("briefing", briefing);
        out.put("digest", digestResult);
        return out;
    }

    private String buildBriefing(List<Job> top) {
        if (top.isEmpty()) {
            return "No new high-match jobs since the last run. Try broadening your skills/queries "
                    + "or adding more company boards.";
        }
        StringBuilder list = new StringBuilder();
        for (Job j : top) {
            list.append("- ").append(j.getTitle()).append(" @ ").append(safe(j.getCompany()))
                    .append(" (").append(safe(j.getLocation())).append(", score ")
                    .append(j.getMatchScore() == null ? "?" : j.getMatchScore())
                    .append(", ").append(j.getApplyType()).append(")\n");
        }
        if (!ai.isEnabled()) {
            return "Today's top matches:\n" + list;
        }
        try {
            String name = profileService.get().getFullName();
            String user = "CANDIDATE: " + name + "\nTOP MATCHES TODAY:\n" + list;
            return ai.complete(SYSTEM, user, false) + "\n\n" + list;
        } catch (Exception e) {
            log.warn("AI briefing failed ({}); using plain list", e.getMessage());
            return "Today's top matches:\n" + list;
        }
    }

    private String safe(String s) {
        return s == null ? "—" : s;
    }
}
