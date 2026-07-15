package com.jobpilot.agent;

import com.jobpilot.security.UserContext;
import com.jobpilot.security.WorkerTokenService;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

/**
 * The dashboard's view of the agent: start/stop portal runs, watch the live frame,
 * read the event stream + metric counters, manage the daily rotation schedule and the
 * Network CRM, and mint the local worker's token. All per-user (UserContext).
 */
@RestController
@RequestMapping("/api/agent")
public class AgentController {

    private final AgentService agent;
    private final WorkerTokenService workerTokens;

    public AgentController(AgentService agent, WorkerTokenService workerTokens) {
        this.agent = agent;
        this.workerTokens = workerTokens;
    }

    // ---- status + metrics -----------------------------------------------------

    @GetMapping("/status")
    public Map<String, Object> status() {
        UUID u = UserContext.require();
        Instant since = Instant.now().truncatedTo(ChronoUnit.DAYS);
        AgentRun run = agent.activeRun(u);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("paused", agent.isPaused());
        m.put("workerConfigured", workerTokens.isConfigured());
        m.put("activeRun", run == null ? null : runView(run));
        m.put("metricsToday", metricMap(agent, u, since));
        m.put("pendingApprovals", agent.pendingApprovals(u));
        LiveFrame f = agent.frame(u);
        m.put("liveAction", f == null ? null : f.getAction());
        m.put("liveUpdatedAt", f == null ? null : f.getUpdatedAt());
        return m;
    }

    private static Map<String, Object> metricMap(AgentService agent, UUID u, Instant since) {
        Map<String, Long> raw = new LinkedHashMap<>();
        for (Object[] row : agent.eventCountsSince(u, since)) raw.put((String) row[0], ((Number) row[1]).longValue());
        // the HireDue-style metric tiles
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("postsAnalysed", raw.getOrDefault("post_analysed", 0L));
        m.put("jobsIdentified", raw.getOrDefault("job_identified", 0L));
        m.put("relevantJobs", raw.getOrDefault("relevant", 0L));
        m.put("applied", raw.getOrDefault("applied", 0L) + raw.getOrDefault("easy_apply", 0L));
        m.put("easyApply", raw.getOrDefault("easy_apply", 0L));
        m.put("connectionsSent", raw.getOrDefault("connection_sent", 0L));
        m.put("messagesSent", raw.getOrDefault("message_sent", 0L));
        m.put("emailsSent", raw.getOrDefault("email_sent", 0L));
        m.put("repliesReceived", raw.getOrDefault("reply_received", 0L));
        m.put("errors", raw.getOrDefault("error", 0L));
        return m;
    }

    // ---- run control ----------------------------------------------------------

    /** "Start Naukri now" — create/attach a run the worker will pick up. */
    @PostMapping("/run")
    public Map<String, Object> startRun(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        String portal = b.getOrDefault("portal", "naukri").toLowerCase(Locale.ROOT);
        if (agent.isPaused()) agent.setPaused(false);
        return runView(agent.startOrGetRun(u, portal));
    }

    @PostMapping("/run/{id}/stop")
    public Map<String, Object> stopRun(@PathVariable UUID id) {
        UUID u = UserContext.require();
        return runView(agent.setRunStatus(u, id, "done", "Stopped by owner"));
    }

    @PostMapping("/pause")
    public Map<String, Object> pause(@RequestBody Map<String, Object> b) {
        UserContext.require();
        boolean paused = b.get("paused") == null || Boolean.parseBoolean(b.get("paused").toString());
        agent.setPaused(paused);
        return Map.of("paused", paused);
    }

    @GetMapping("/runs")
    public List<Map<String, Object>> runs(@RequestParam(defaultValue = "20") int limit) {
        return agent.recentRuns(UserContext.require(), limit).stream().map(AgentController::runView).toList();
    }

    // ---- live frame + events --------------------------------------------------

    @GetMapping("/frame")
    public Map<String, Object> frame() {
        LiveFrame f = agent.frame(UserContext.require());
        if (f == null) return Map.of("hasFrame", false);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("hasFrame", f.getImageB64() != null && !f.getImageB64().isBlank());
        m.put("portal", f.getPortal());
        m.put("action", f.getAction());
        m.put("imageB64", f.getImageB64());
        m.put("updatedAt", f.getUpdatedAt());
        return m;
    }

    @GetMapping("/events")
    public List<Map<String, Object>> events(@RequestParam(defaultValue = "50") int limit) {
        return agent.recentEvents(UserContext.require(), limit).stream().map(e -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", e.getId().toString());
            m.put("type", e.getType());
            m.put("portal", e.getPortal());
            m.put("title", e.getTitle());
            m.put("company", e.getCompany());
            m.put("url", e.getUrl());
            m.put("detail", e.getDetail());
            m.put("createdAt", e.getCreatedAt());
            return m;
        }).toList();
    }

    // ---- schedule -------------------------------------------------------------

    @GetMapping("/schedule")
    public List<AgentSchedule> schedule() {
        return agent.schedule(UserContext.require());
    }

    @PutMapping("/schedule")
    public List<AgentSchedule> saveSchedule(@RequestBody List<AgentSchedule> blocks) {
        return agent.saveSchedule(UserContext.require(), blocks);
    }

    /** Advance the rotation now (also runs automatically every few minutes). */
    @PostMapping("/rotation/run")
    public Map<String, Object> rotateNow() {
        return Map.of("result", agent.tickRotationForUser(UserContext.require()));
    }

    // ---- Network CRM ----------------------------------------------------------

    @GetMapping("/contacts")
    public List<PortalContact> contacts(@RequestParam(defaultValue = "100") int limit) {
        return agent.contacts(UserContext.require(), limit);
    }

    @GetMapping("/messages")
    public List<AgentMessage> messages(@RequestParam(required = false) String status,
                                       @RequestParam(defaultValue = "100") int limit) {
        return agent.messages(UserContext.require(), status, limit);
    }

    /** Approve a drafted message (optionally edited) so the worker may send it. */
    @PostMapping("/messages/{id}/approve")
    public AgentMessage approve(@PathVariable UUID id, @RequestBody(required = false) Map<String, String> b) {
        return agent.setMessageStatus(UserContext.require(), id, "approved", b == null ? null : b.get("body"));
    }

    @PostMapping("/messages/{id}/reject")
    public AgentMessage reject(@PathVariable UUID id) {
        return agent.setMessageStatus(UserContext.require(), id, "rejected", null);
    }

    // ---- portal connections (the Connect UX) ----------------------------------

    @GetMapping("/connections")
    public List<PortalConnection> connections() {
        return agent.connections(UserContext.require());
    }

    @PostMapping("/connections/{portal}/connect")
    public PortalConnection connect(@PathVariable String portal) {
        return agent.requestConnection(UserContext.require(), portal.toLowerCase(Locale.ROOT), "connect");
    }

    @PostMapping("/connections/{portal}/disconnect")
    public PortalConnection disconnect(@PathVariable String portal) {
        return agent.requestConnection(UserContext.require(), portal.toLowerCase(Locale.ROOT), "disconnect");
    }

    // ---- worker token ---------------------------------------------------------

    /** Mint a fresh worker token (shown once) for the local worker's config. */
    @PostMapping("/worker-token")
    public Map<String, Object> issueToken() {
        UUID u = UserContext.require();
        return Map.of("token", workerTokens.issue(u));
    }

    // ---- helpers --------------------------------------------------------------

    private static Map<String, Object> runView(AgentRun r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", r.getId().toString());
        m.put("portal", r.getPortal());
        m.put("status", r.getStatus());
        m.put("currentAction", r.getCurrentAction());
        m.put("startedAt", r.getStartedAt());
        m.put("endedAt", r.getEndedAt());
        m.put("searched", r.getSearched());
        m.put("evaluated", r.getEvaluated());
        m.put("applied", r.getApplied());
        m.put("connected", r.getConnected());
        m.put("messaged", r.getMessaged());
        m.put("failed", r.getFailed());
        m.put("note", r.getNote());
        m.put("createdAt", r.getCreatedAt());
        return m;
    }
}
