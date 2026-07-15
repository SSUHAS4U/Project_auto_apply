package com.jobpilot.engine;

import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Autopilot — runs the Engine's whole ai-job-search cycle unattended:
 * <b>scrape → rank → auto-apply the best-fit shortlist</b> (up to a daily cap, at/above a
 * minimum fit). The daily scheduler calls {@link #runAllDue()} once a day; the dashboard
 * can also trigger {@link #runDailyCycle} on demand. Everything is gated on the profile's
 * {@code autoEnabled} switch, so nothing runs until the owner turns it on.
 */
@Service
public class EngineOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(EngineOrchestrator.class);

    private final EngineProfileRepository profiles;
    private final EngineJobRepository jobs;
    private final EngineApplicationRepository apps;
    private final EngineScraperService scraper;
    private final EngineRankService rank;
    private final EngineApplyService apply;
    private final EngineSetupService setup;
    private final AiService ai;

    /** One cycle per user at a time. */
    private final Map<UUID, AtomicBoolean> running = new ConcurrentHashMap<>();

    public EngineOrchestrator(EngineProfileRepository profiles, EngineJobRepository jobs,
                              EngineApplicationRepository apps, EngineScraperService scraper,
                              EngineRankService rank, EngineApplyService apply,
                              EngineSetupService setup, AiService ai) {
        this.profiles = profiles;
        this.jobs = jobs;
        this.apps = apps;
        this.scraper = scraper;
        this.rank = rank;
        this.apply = apply;
        this.setup = setup;
        this.ai = ai;
    }

    public boolean isRunning(UUID userId) {
        return running.computeIfAbsent(userId, k -> new AtomicBoolean(false)).get();
    }

    /** The scheduler entry point — run today's cycle for every profile that opted in. */
    public void runAllDue() {
        List<EngineProfile> due = profiles.findByAutoEnabledTrue();
        log.info("Engine autopilot: {} profile(s) enabled", due.size());
        for (EngineProfile p : due) {
            try {
                runDailyCycle(p.getUserId(), "scheduled");
            } catch (Exception e) {
                log.warn("Engine autopilot failed for {}: {}", p.getUserId(), e.getMessage());
            }
        }
    }

    /**
     * Run one full cycle for a user. Safe to call manually ("Run now") or on schedule.
     * Returns a summary the dashboard shows.
     */
    public Map<String, Object> runDailyCycle(UUID userId, String trigger) {
        AtomicBoolean flag = running.computeIfAbsent(userId, k -> new AtomicBoolean(false));
        if (!flag.compareAndSet(false, true))
            return Map.of("status", "already_running");
        try {
            EngineProfile p = profiles.findByUserId(userId).orElse(null);
            if (p == null) return Map.of("status", "no_profile");
            if (!setup.isReady(userId)) {
                return finish(p, "Skipped — setup not complete (add target roles in Setup).", 0, 0, 0);
            }

            int scraped = 0, ranked = 0, started = 0;

            // 1. SCRAPE — refresh the seen-store from the portal
            try {
                Object added = scraper.run(userId).get("added");
                scraped = added instanceof Number n ? n.intValue() : 0;
            } catch (Exception e) {
                log.warn("autopilot scrape failed for {}: {}", userId, e.getMessage());
            }

            // 2. RANK — score the new postings (needs AI)
            if (ai.isEnabled()) {
                try {
                    Object r = rank.run(userId).get("ranked");
                    ranked = r instanceof Number n ? n.intValue() : 0;
                } catch (Exception e) {
                    log.warn("autopilot rank failed for {}: {}", userId, e.getMessage());
                }
            }

            // 3. APPLY — best-fit shortlist, within today's remaining budget
            Instant startOfDay = Instant.now().truncatedTo(ChronoUnit.DAYS);
            long usedToday = apps.countByUserIdAndCreatedAtAfter(userId, startOfDay);
            int budget = Math.max(0, p.getDailyCap() - (int) usedToday);
            if (budget > 0 && ai.isEnabled()) {
                List<EngineJob> shortlist = jobs.findByUserIdAndStatusOrderByFitScoreDesc(
                        userId, "shortlisted", PageRequest.of(0, budget));
                for (EngineJob j : shortlist) {
                    if (started >= budget) break;
                    if (j.getFitScore() == null || j.getFitScore() < p.getMinFit()) continue;
                    try {
                        apply.start(userId, j.getId(), null, null);  // async pipeline
                        started++;
                    } catch (Exception e) {
                        log.warn("autopilot apply failed for job {}: {}", j.getId(), e.getMessage());
                    }
                }
            }

            String note = trigger + ": scraped " + scraped + " new, ranked " + ranked
                    + ", started " + started + " application(s)"
                    + (ai.isEnabled() ? "" : " (AI off — scrape only)");
            return finish(p, note, scraped, ranked, started);
        } finally {
            flag.set(false);
        }
    }

    private Map<String, Object> finish(EngineProfile p, String summary, int scraped, int ranked, int started) {
        p.setLastRunAt(Instant.now());
        p.setLastRunSummary(summary);
        profiles.save(p);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "done");
        out.put("scraped", scraped);
        out.put("ranked", ranked);
        out.put("started", started);
        out.put("summary", summary);
        return out;
    }
}
