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
import java.util.UUID;

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

    /**
     * NOT @Transactional on purpose.
     *
     * The first thing this does is a full ingest — minutes of outbound HTTP across ~90 job
     * boards. Wrapping that in a transaction held one database connection open for the whole
     * fetch while doing nothing with it. Each persistence step below manages its own.
     */
    public Map<String, Object> run() {
        IngestService.IngestResult ing = ingest.run();

        int threshold = props.getDigest().getMinScore();
        Instant since = settings.getInstant(K_RUN_AT)
                .orElse(Instant.now().minus(1, ChronoUnit.DAYS));

        List<Job> top = jobService.search(null, null, threshold, null, since, 0, 8).getContent();

        // Curate for every account that has a profile.
        //
        // These rows are what /api/daily/picks SERVES. Before this they were written here and
        // read by nobody — findAllByOrderByRankAsc() had no caller anywhere in the backend —
        // while the endpoint re-ran a board query instead. The ranking was recomputed daily,
        // the AI briefing was paid for daily, and both were discarded.
        int curatedFor = 0;
        for (UUID userId : curationAudience()) {
            try {
                curate(userId, top);
                curatedFor++;
            } catch (Exception e) {
                log.warn("Daily curation failed for user {}: {}", userId, e.getMessage());
            }
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
        out.put("curatedFor", curatedFor);
        out.put("purged", purged);
        out.put("briefing", briefing);
        out.put("digest", digestResult);
        return out;
    }

    /** Every account holding a profile. Picks are per-user, so each gets its own set. */
    private List<UUID> curationAudience() {
        return profileService.allProfiles().stream()
                .map(com.jobpilot.domain.Profile::getUserId)
                .filter(java.util.Objects::nonNull)
                .distinct()
                .toList();
    }

    /**
     * Replace one user's curated set.
     *
     * No @Transactional: this is called from run() on the same bean, so it never passes
     * through Spring's proxy and the annotation would be decoration. The delete carries its
     * own transaction on the repository method; each save carries its own. The caller wraps
     * this per user, so one account failing cannot stop the others being curated.
     */
    protected void curate(UUID userId, List<Job> top) {
        pickRepo.deleteByUserId(userId);
        int rank = 1;
        for (Job j : top) {
            DailyPick p = new DailyPick();
            p.setUserId(userId);
            p.setJobId(j.getId());
            p.setRank(rank++);
            pickRepo.save(p);
        }
    }

    /** Daily Picks for the CURRENT user: their top recent high-match jobs + a briefing
     *  addressed to THEM (cached per user + per run so it greets the logged-in user, not the owner). */
    @Transactional(readOnly = true)
    public Map<String, Object> picks() {
        com.jobpilot.domain.Profile me = profileService.get();

        // What the daily run actually curated for this user, in rank order.
        List<Job> picked = curatedJobs(me.getUserId());
        boolean curated = !picked.isEmpty();

        // Fallback: a fresh account, or a day the run has not happened yet. Showing the
        // board's best is more useful than an empty page — but it is NOT curation, and the
        // response says so rather than letting the page claim an AI pass that never ran.
        final List<Job> jobs = curated ? picked
                : jobService.search(null, null, Math.max(40, props.getDigest().getMinScore() - 10),
                        null, null, null, 14, 0, 12).getContent();

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
        out.put("curated", curated);
        out.put("jobs", jobs);
        return out;
    }

    /**
     * The user's curated picks, resolved to jobs and kept in rank order.
     *
     * findAllById does not preserve the id order it was given, and a pick whose job has since
     * been purged simply drops out — so the ranking is re-applied here rather than trusted
     * from the query.
     */
    private List<Job> curatedJobs(UUID userId) {
        if (userId == null) return List.of();
        List<DailyPick> picks = pickRepo.findByUserIdOrderByRankAsc(userId);
        if (picks.isEmpty()) return List.of();
        Map<UUID, Job> byId = jobService.findAllById(
                picks.stream().map(DailyPick::getJobId).filter(java.util.Objects::nonNull).toList());
        return picks.stream()
                .map(p -> byId.get(p.getJobId()))
                .filter(java.util.Objects::nonNull)
                .toList();
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
