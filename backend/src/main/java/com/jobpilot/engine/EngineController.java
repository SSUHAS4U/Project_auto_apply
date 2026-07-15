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
    @PostMapping("/autopilot/toggle")
    public Map<String, Object> autopilotToggle(@RequestBody Map<String, Object> body) {
        UUID u = UserContext.require();
        boolean enabled = body.get("enabled") != null && Boolean.parseBoolean(body.get("enabled").toString());
        EngineProfile p = setup.get(u);
        p.setAutoEnabled(enabled);
        profiles.save(p);
        return Map.of("enabled", enabled);
    }

    /** Save autopilot limits (applies/day, minimum fit). */
    @PutMapping("/autopilot/config")
    public Map<String, Object> autopilotConfig(@RequestBody Map<String, Object> body) {
        UUID u = UserContext.require();
        EngineProfile p = setup.get(u);
        if (body.get("dailyCap") != null) p.setDailyCap(Math.max(0, Math.min(200, ((Number) body.get("dailyCap")).intValue())));
        if (body.get("minFit") != null) p.setMinFit(Math.max(0, Math.min(100, ((Number) body.get("minFit")).intValue())));
        profiles.save(p);
        return Map.of("dailyCap", p.getDailyCap(), "minFit", p.getMinFit());
    }

    /** Run the whole cycle now (scrape → rank → auto-apply), in the background. */
    @PostMapping("/autopilot/run")
    public Map<String, Object> autopilotRun() {
        UUID u = UserContext.require();
        if (orchestrator.isRunning(u)) return Map.of("status", "already_running");
        pool.submit(() -> {
            try { orchestrator.runDailyCycle(u, "manual"); }
            catch (Exception e) { log.warn("manual engine cycle failed: {}", e.getMessage()); }
        });
        return Map.of("status", "started");
    }

    // ---- /setup ---------------------------------------------------------------

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
    @PostMapping("/setup")
    public EngineProfile runSetup(@RequestBody Map<String, Object> body) {
        return setup.run(UserContext.require(),
                str(body.get("pastedCv")),
                str(body.get("interviewAnswers")),
                body.get("useStoredResume") == null || Boolean.parseBoolean(str(body.get("useStoredResume"))));
    }

    @PutMapping("/profile/{doc}")
    public EngineProfile saveDoc(@PathVariable String doc, @RequestBody Map<String, String> body) {
        return setup.saveDoc(UserContext.require(), doc, body.getOrDefault("content", ""));
    }

    // ---- /scrape --------------------------------------------------------------

    @PostMapping("/scrape")
    public Map<String, Object> scrape() {
        UUID u = UserContext.require();
        if (scraper.isRunning(u)) return Map.of("status", "already_running");
        pool.submit(() -> {
            try { scraper.run(u); }
            catch (Exception e) { log.warn("scrape failed: {}", e.getMessage()); }
        });
        return Map.of("status", "started");
    }

    // ---- /rank ----------------------------------------------------------------

    @PostMapping("/rank")
    public Map<String, Object> rank() {
        UUID u = UserContext.require();
        if (rank.isRunning(u)) return Map.of("status", "already_running");
        pool.submit(() -> {
            try { rank.run(u); }
            catch (Exception e) { log.warn("rank failed: {}", e.getMessage()); }
        });
        return Map.of("status", "started");
    }

    // ---- jobs (scrape results / ranked shortlist) -----------------------------

    @GetMapping("/jobs")
    public List<EngineJob> listJobs(@RequestParam(required = false) String status,
                                    @RequestParam(defaultValue = "100") int limit) {
        UUID u = UserContext.require();
        var page = PageRequest.of(0, Math.min(limit, 300));
        if ("ranked".equals(status)) return jobs.findRanked(u, page);
        return status == null
                ? jobs.findByUserIdOrderByScrapedAtDesc(u, page)
                : jobs.findByUserIdAndStatusOrderByScrapedAtDesc(u, status, page);
    }

    @PostMapping("/jobs/{id}/dismiss")
    public Map<String, Object> dismiss(@PathVariable UUID id) {
        UUID u = UserContext.require();
        EngineJob j = jobs.findById(id).filter(x -> x.getUserId().equals(u)).orElseThrow();
        j.setStatus("dismissed");
        jobs.save(j);
        return Map.of("id", id.toString(), "status", "dismissed");
    }

    // ---- /apply ---------------------------------------------------------------

    @PostMapping("/apply")
    public EngineApplication startApply(@RequestBody Map<String, Object> body) {
        UUID u = UserContext.require();
        UUID jobId = body.get("jobId") == null ? null : UUID.fromString(str(body.get("jobId")));
        return apply.start(u, jobId, str(body.get("url")), str(body.get("pastedText")));
    }

    @GetMapping("/applications")
    public List<EngineApplicationRepository.Summary> listApps(@RequestParam(required = false) String stage,
                                                              @RequestParam(defaultValue = "100") int limit) {
        UUID u = UserContext.require();
        var page = PageRequest.of(0, Math.min(limit, 300));
        return stage == null
                ? apps.findByUserIdOrderByUpdatedAtDesc(u, page)
                : apps.findByUserIdAndStageOrderByUpdatedAtDesc(u, stage, page);
    }

    @GetMapping("/applications/{id}")
    public EngineApplication appDetail(@PathVariable UUID id) {
        return apply.owned(UserContext.require(), id);
    }

    @GetMapping("/applications/{id}/cv.pdf")
    public ResponseEntity<byte[]> cvPdf(@PathVariable UUID id) {
        return pdf(apply.owned(UserContext.require(), id).getCvPdf(), "cv.pdf");
    }

    @GetMapping("/applications/{id}/cover.pdf")
    public ResponseEntity<byte[]> coverPdf(@PathVariable UUID id) {
        return pdf(apply.owned(UserContext.require(), id).getCoverPdf(), "cover-letter.pdf");
    }

    @PostMapping("/applications/{id}/submit")
    public EngineApplication submit(@PathVariable UUID id, @RequestBody Map<String, String> body) {
        return apply.submitByEmail(UserContext.require(), id, body.getOrDefault("to", ""));
    }

    @PostMapping("/applications/{id}/outcome")
    public EngineApplication outcome(@PathVariable UUID id, @RequestBody Map<String, String> body) {
        return apply.recordOutcome(UserContext.require(), id,
                body.getOrDefault("outcome", ""), body.getOrDefault("notes", ""));
    }

    // ---- /interview -----------------------------------------------------------

    @PostMapping("/interview")
    public EngineInterview genInterview(@RequestBody Map<String, String> body) {
        return interview.generate(UserContext.require(),
                UUID.fromString(body.get("applicationId")),
                body.getOrDefault("stageLabel", "first interview"));
    }

    @GetMapping("/interview")
    public List<EngineInterview> listInterviews() {
        return interview.list(UserContext.require());
    }

    // ---- /upskill -------------------------------------------------------------

    @PostMapping("/upskill")
    public EngineUpskill runUpskill() {
        return upskill.run(UserContext.require());
    }

    @GetMapping("/upskill")
    public List<EngineUpskill> listUpskill() {
        return upskill.list(UserContext.require());
    }

    // ---- helpers --------------------------------------------------------------

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
