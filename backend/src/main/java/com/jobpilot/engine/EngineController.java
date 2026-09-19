package com.jobpilot.engine;

import com.jobpilot.security.UserContext;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The Engine's REST surface — a clean-room replica of the ai-job-search commands,
 * entirely separate from JobPilot's existing job flow. All routes are per-user
 * (UserContext set by AuthFilter). Long jobs (scrape, rank) run in the background;
 * the dashboard polls status.
 */
@RestController
@RequestMapping("/api/engine")
public class EngineController {

    private static final Logger log = LoggerFactory.getLogger(EngineController.class);

    private final EngineSetupService setup;
    private final EngineScraperService scraper;
    private final EngineRankService rank;
    private final EngineApplyService apply;
    private final EngineInterviewService interview;
    private final EngineUpskillService upskill;
    private final EngineJobRepository jobs;
    private final EngineApplicationRepository apps;
    private final EngineProfileRepository profiles;
    private final EngineOrchestrator orchestrator;
    private final AiService ai;

    private final ExecutorService pool = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "engine-bg");
        t.setDaemon(true);
        return t;
    });

    public EngineController(EngineSetupService setup, EngineScraperService scraper, EngineRankService rank,
                            EngineApplyService apply, EngineInterviewService interview,
                            EngineUpskillService upskill, EngineJobRepository jobs,
                            EngineApplicationRepository apps, EngineProfileRepository profiles,
                            EngineOrchestrator orchestrator, AiService ai) {
        this.setup = setup;
        this.scraper = scraper;
        this.rank = rank;
        this.apply = apply;
        this.interview = interview;
        this.upskill = upskill;
        this.jobs = jobs;
        this.apps = apps;
        this.profiles = profiles;
        this.orchestrator = orchestrator;
        this.ai = ai;
    }

    // ---- status / dashboard ---------------------------------------------------

    @GetMapping("/status")
    public Map<String, Object> status() {
        UUID u = UserContext.require();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("aiEnabled", ai.isEnabled());
        m.put("setupReady", setup.isReady(u));
        m.put("checklist", setup.checklist(u));
        m.put("scrapeRunning", scraper.isRunning(u));
        m.put("scrapeProgress", scraper.progress(u));
        m.put("rankRunning", rank.isRunning(u));
        m.put("rankProgress", rank.progress(u));
        m.put("jobStatusCounts", counts(jobs.countByStatus(u)));
        m.put("appStageCounts", counts(apps.countByStage(u)));
        EngineProfile p = setup.get(u);
        Map<String, Object> auto = new LinkedHashMap<>();
        auto.put("enabled", p.isAutoEnabled());
        auto.put("dailyCap", p.getDailyCap());
        auto.put("minFit", p.getMinFit());
        auto.put("running", orchestrator.isRunning(u));
        auto.put("lastRunAt", p.getLastRunAt());
        auto.put("lastRunSummary", p.getLastRunSummary());
        m.put("autopilot", auto);
        return m;
    }

    // ---- autopilot (daily self-running cycle) ---------------------------------

    /** Turn the daily autopilot on/off. */

    // ---- WHAT USED TO BE HERE --------------------------------------------------
    //
    // Nineteen more endpoints: autopilot toggle/config/run, setup, profile/{doc}, scrape,
    // rank, jobs, jobs/{id}/dismiss, apply, applications (list/one/cv.pdf/cover.pdf/submit/
    // outcome), interview (GET/POST) and upskill (GET/POST).
    //
    // NOTHING CALLED THEM. Not the dashboard, not the extension, not the worker, not a
    // workflow — verified with scripts/api-reachability.py, which parses every mapping in the
    // backend and cross-references every /api/ literal in every client. The autopilot cron
    // that once drove them has been disabled since the engine's UI was removed
    // (jobpilot.schedule.auto-apply-cron defaults to "-").
    //
    // They were deleted rather than kept "just in case": an endpoint with no caller is one
    // nobody tests and everybody still has to secure, and this one sat behind a JWT on a
    // surface a third of which did nothing. The services behind them are UNTOUCHED — /status
    // still reports scrape, rank and autopilot state, so EngineScraperService,
    // EngineRankService and EngineOrchestrator all remain live.
    //
    // git log is the archive. See docs/adr/ADR-002-backend-boundaries.md.

    @GetMapping("/profile")
    public EngineProfile profile() {
        return setup.get(UserContext.require());
    }

    /** The real details we already have (from the app Profile) — shown on the Setup screen. */
    @GetMapping("/prefill")
    public Map<String, Object> prefill() {
        UserContext.require();
        return setup.appProfileSummary();
    }

    /** Guided setup — no AI needed; makes Scrape work immediately. */
    @PostMapping("/guided")
    public EngineProfile guided(@RequestBody Map<String, Object> body) {
        return setup.saveGuided(UserContext.require(),
                strList(body.get("roles")), strList(body.get("locations")),
                str(body.get("careerGoal")), strList(body.get("dealBreakers")), str(body.get("wins")));
    }

    /** AI enhancement — richer docs (needs an AI provider). Optional. */

    // ---- helpers ------------------------------------------------------------

    private static Map<String, Long> counts(List<Object[]> rows) {
        Map<String, Long> m = new LinkedHashMap<>();
        for (Object[] r : rows) m.put((String) r[0], ((Number) r[1]).longValue());
        return m;
    }

    private static ResponseEntity<byte[]> pdf(byte[] bytes, String name) {
        if (bytes == null || bytes.length == 0) return ResponseEntity.notFound().build();
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + name + "\"")
                .contentType(MediaType.APPLICATION_PDF)
                .body(bytes);
    }

    private static String str(Object o) { return o == null ? null : o.toString(); }

    private static List<String> strList(Object o) {
        if (o instanceof List<?> l) return l.stream().filter(java.util.Objects::nonNull).map(Object::toString).toList();
        if (o instanceof String s && !s.isBlank())
            return java.util.Arrays.stream(s.split(",")).map(String::trim).filter(x -> !x.isEmpty()).toList();
        return List.of();
    }
}
