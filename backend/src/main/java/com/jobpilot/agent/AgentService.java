package com.jobpilot.agent;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.KeywordMatchScorer;
import com.jobpilot.service.ProfileService;
import com.jobpilot.service.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.concurrent.ConcurrentHashMap;

import java.time.Instant;
import java.util.*;

/**
 * The agent "brain": run lifecycle, the event stream (which powers every dashboard
 * metric), the daily rotation schedule, and the pause switch. The actual browser work
 * happens in the LOCAL worker; this coordinates and records it.
 */
@Service
public class AgentService {

    private static final Logger log = LoggerFactory.getLogger(AgentService.class);

    /** Statuses that mean "this run is still the active one". */
    private static final List<String> LIVE = List.of("queued", "running", "paused", "needs_attention");
    private static final String PAUSED_KEY = "agent_paused";

    private final AgentRunRepository runs;
    private final AgentEventRepository events;
    private final AgentScheduleRepository schedules;
    private final LiveFrameService frames;
    private final SettingsService settings;
    private final ProfileService profiles;
    private final KeywordMatchScorer scorer;
    private final PortalContactRepository contacts;
    private final AgentMessageRepository messages;
    private final PortalConnectionRepository connections;
    private final com.jobpilot.service.ai.AiService ai;
    private final com.jobpilot.engine.EngineProfileRepository engineProfiles;
    private final com.jobpilot.service.NotificationService notifications;
    private final com.jobpilot.service.MailService mail;
    private final com.jobpilot.repository.ProfileRepository profileRepo;
    private final com.fasterxml.jackson.databind.ObjectMapper json = new com.fasterxml.jackson.databind.ObjectMapper();

    private static final List<String> PORTALS = List.of("linkedin", "naukri", "indeed");

    public AgentService(AgentRunRepository runs, AgentEventRepository events,
                        AgentScheduleRepository schedules, LiveFrameService frames,
                        SettingsService settings, ProfileService profiles, KeywordMatchScorer scorer,
                        PortalContactRepository contacts, AgentMessageRepository messages,
                        PortalConnectionRepository connections,
                        com.jobpilot.service.ai.AiService ai,
                        com.jobpilot.engine.EngineProfileRepository engineProfiles,
                        com.jobpilot.service.NotificationService notifications,
                        com.jobpilot.service.MailService mail,
                        com.jobpilot.repository.ProfileRepository profileRepo,
                        com.jobpilot.repository.ApplicationRepository applications) {
        this.runs = runs;
        this.events = events;
        this.schedules = schedules;
        this.frames = frames;
        this.settings = settings;
        this.profiles = profiles;
        this.scorer = scorer;
        this.contacts = contacts;
        this.messages = messages;
        this.connections = connections;
        this.engineProfiles = engineProfiles;
        this.ai = ai;
        this.notifications = notifications;
        this.mail = mail;
        this.profileRepo = profileRepo;
        this.applications = applications;
    }

    private final com.jobpilot.repository.ApplicationRepository applications;

    /**
     * Wipe this user's automation activity for a clean test run: the event feed (so the
     * dashboard tiles go to 0), run history, outreach messages + network contacts, and the
     * engine's application packages. Does NOT touch the shared job pool or your profile.
     */
    @org.springframework.transaction.annotation.Transactional
    public void resetAutomationData(UUID userId) {
        events.deleteByUserId(userId);
        runs.deleteByUserId(userId);
        messages.deleteByUserId(userId);
        contacts.deleteByUserId(userId);
        applications.deleteByUserId(userId);
    }

    // ---- manual-apply daily digest ------------------------------------------

    /**
     * Once a day: email each user the jobs the automation FOUND but could not apply to
     * (no Easy Apply / employer-site form) — the owner applies to those by hand.
     */
    @Transactional(readOnly = true)
    public void emailManualApplyDigests() {
        java.util.Set<UUID> users = new java.util.LinkedHashSet<>();
        for (AgentSchedule b : schedules.findAll()) users.add(b.getUserId());
        Instant since = Instant.now().minus(java.time.Duration.ofHours(24));
        for (UUID u : users) {
            try {
                List<AgentEvent> manual = events.findByUserIdOrderByCreatedAtDesc(u, PageRequest.of(0, 300)).stream()
                        .filter(e -> "manual_apply".equals(e.getType()) && e.getCreatedAt() != null
                                && e.getCreatedAt().isAfter(since))
                        .toList();
                if (manual.isEmpty()) continue;
                String to = profileRepo.findByUserId(u)
                        .map(com.jobpilot.domain.Profile::getEmail).filter(s -> s != null && !s.isBlank())
                        .orElse(null);
                StringBuilder body = new StringBuilder("These jobs matched you today but need a MANUAL application "
                        + "(no Easy Apply / employer-site form):\n\n");
                for (AgentEvent e : manual) {
                    body.append("• ").append(nz(e.getTitle(), "Job"))
                        .append(e.getCompany() == null ? "" : " — " + e.getCompany())
                        .append(" [").append(nz(e.getPortal(), "")).append("]\n");
                    if (e.getUrl() != null) body.append("  ").append(e.getUrl()).append('\n');
                    if (e.getDetail() != null) body.append("  ").append(e.getDetail()).append('\n');
                    body.append('\n');
                }
                body.append("— JobPilot");
                if (to != null) {
                    mail.sendWithAttachments(to, "JobPilot — " + manual.size()
                            + " job(s) to apply manually today", body.toString(), List.of(), null);
                }
                notifications.create(u, "reminder", manual.size() + " job(s) need a manual application",
                        "The automation found matches it couldn't auto-apply to — check your email for the list.",
                        Map.of("count", manual.size()));
            } catch (Exception e) {
                log.warn("manual-apply digest failed for {}: {}", u, e.getMessage());
            }
        }
    }

    // ---- worker heartbeat (is JobPilot Desktop actually running?) -----------

    private final Map<UUID, Instant> lastWorkerSeen = new ConcurrentHashMap<>();

    /** Called on every worker request — the app's "I'm alive" ping. */
    public void markWorkerSeen(UUID userId) {
        lastWorkerSeen.put(userId, Instant.now());
    }

    /** True if JobPilot Desktop has pinged within the last 30s (it polls every ~4s). */
    public boolean isWorkerOnline(UUID userId) {
        Instant t = lastWorkerSeen.get(userId);
        return t != null && t.isAfter(Instant.now().minusSeconds(30));
    }

    // ---- portal connections (the "Connect" UX) ------------------------------

    /** Give a stuck "connecting" this long before we call it failed (covers slow sign-ins). */
    private static final long CONNECT_TIMEOUT_SECONDS = 150;

    /** All portal connections, seeding rows and expiring any stuck "connecting" state. */
    @Transactional
    public List<PortalConnection> connections(UUID userId) {
        for (String portal : PORTALS) {
            if (connections.findByUserIdAndPortal(userId, portal).isEmpty()) {
                PortalConnection c = new PortalConnection();
                c.setUserId(userId);
                c.setPortal(portal);
                connections.save(c);
            }
        }
        List<PortalConnection> list = connections.findByUserIdOrderByPortalAsc(userId);
        boolean online = isWorkerOnline(userId);
        for (PortalConnection c : list) {
            if ("connecting".equals(c.getStatus())
                    && c.getUpdatedAt().isBefore(Instant.now().minusSeconds(CONNECT_TIMEOUT_SECONDS))) {
                c.setStatus("disconnected");
                c.setRequestedAction(null);
                c.setDetail(online ? "Sign-in timed out — try Connect again."
                        : "JobPilot Desktop isn't running — start it, then click Connect.");
                c.setUpdatedAt(Instant.now());
                connections.save(c);
            }
        }
        return list;
    }

    /** Dashboard asks to connect/disconnect — queues the action for the worker. */
    @Transactional
    public PortalConnection requestConnection(UUID userId, String portal, String action) {
        if (!PORTALS.contains(portal)) throw new IllegalArgumentException("unknown portal: " + portal);
        PortalConnection c = connections.findByUserIdAndPortal(userId, portal)
                .orElseGet(() -> {
                    PortalConnection n = new PortalConnection();
                    n.setUserId(userId);
                    n.setPortal(portal);
                    return n;
                });
        c.setRequestedAction(action);
        c.setStatus("connect".equals(action) ? "connecting" : "disconnected");
        c.setUpdatedAt(Instant.now());
        return connections.save(c);
    }

    /** Worker pulls pending connect/disconnect actions and they're cleared once delivered. */
    @Transactional
    public List<Map<String, String>> pullConnectionActions(UUID userId) {
        List<Map<String, String>> out = new ArrayList<>();
        for (PortalConnection c : connections.findByUserIdOrderByPortalAsc(userId)) {
            if (c.getRequestedAction() != null && !c.getRequestedAction().isBlank()) {
                out.add(Map.of("portal", c.getPortal(), "action", c.getRequestedAction()));
                c.setRequestedAction(null);
                c.setUpdatedAt(Instant.now());
                connections.save(c);
            }
        }
        return out;
    }

    /** Worker reports whether it has a logged-in session for a portal. */
    @Transactional
    public void reportSession(UUID userId, String portal, boolean loggedIn, String detail) {
        if (!PORTALS.contains(portal)) return;
        PortalConnection c = connections.findByUserIdAndPortal(userId, portal)
                .orElseGet(() -> {
                    PortalConnection n = new PortalConnection();
                    n.setUserId(userId);
                    n.setPortal(portal);
                    return n;
                });
        if (loggedIn) {
            c.setStatus("connected");
            c.setDetail(detail);
            c.setUpdatedAt(Instant.now());
        } else if (!"connecting".equals(c.getStatus())) {
            // Not logged in — but DON'T clobber an in-progress "connecting" (the user is
            // mid-sign-in on the login page the worker just opened). Only the connect
            // timeout in connections() ends a stuck "connecting".
            c.setStatus("disconnected");
            c.setDetail(detail);
            c.setUpdatedAt(Instant.now());
        }
        connections.save(c);
    }

    // ---- pause switch -------------------------------------------------------

    public boolean isPaused() {
        return settings.get(PAUSED_KEY).map("true"::equals).orElse(false);
    }

    @Transactional
    public void setPaused(boolean paused) {
        settings.put(PAUSED_KEY, String.valueOf(paused));
    }

    // ---- run lifecycle ------------------------------------------------------

    /** Return the active run for this portal, or start a new one. */
    @Transactional
    public AgentRun startOrGetRun(UUID userId, String portal) {
        Optional<AgentRun> existing = runs.findFirstByUserIdAndPortalAndStatusInOrderByCreatedAtDesc(
                userId, portal, LIVE);
        if (existing.isPresent()) {
            AgentRun r = existing.get();
            if ("queued".equals(r.getStatus())) { r.setStatus("running"); r.setStartedAt(Instant.now()); }
            return runs.save(r);
        }
        AgentRun r = new AgentRun();
        r.setUserId(userId);
        r.setPortal(portal);
        r.setStatus("running");
        r.setStartedAt(Instant.now());
        r.setCurrentAction("Starting " + portal + " session");
        AgentRun saved = runs.save(r);
        recordEvent(userId, saved.getId(), null, portal, "info",
                "Started " + portal + " session", null, null, null);
        return saved;
    }

    @Transactional
    public AgentRun setRunStatus(UUID userId, UUID runId, String status, String currentAction) {
        AgentRun r = runs.findById(runId).orElseThrow();
        boolean becameAttention = "needs_attention".equals(status) && !"needs_attention".equals(r.getStatus());
        if (status != null) r.setStatus(status);
        if (currentAction != null) r.setCurrentAction(currentAction);
        if ("done".equals(status) || "failed".equals(status)) r.setEndedAt(Instant.now());
        AgentRun saved = runs.save(r);
        if (becameAttention) {
            try {
                notifications.create(userId, "agent_attention", "Agent needs attention — " + r.getPortal(),
                        nz(currentAction, "A checkpoint/captcha is blocking the run. Open the app and solve it."),
                        Map.of("portal", nz(r.getPortal(), "")));
            } catch (Exception ex) { log.warn("notification create failed: {}", ex.getMessage()); }
        }
        return saved;
    }

    public List<AgentRun> recentRuns(UUID userId, int limit) {
        return runs.findByUserIdOrderByCreatedAtDesc(userId, PageRequest.of(0, limit));
    }

    /** The current live run, if any. */
    public AgentRun activeRun(UUID userId) {
        for (String s : List.of("running", "needs_attention", "paused", "queued")) {
            Optional<AgentRun> r = runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(userId, s);
            if (r.isPresent()) return r.get();
        }
        return null;
    }

    // ---- events (the metric source) -----------------------------------------

    @Transactional
    public AgentEvent recordEvent(UUID userId, UUID runId, UUID taskId, String portal, String type,
                                  String title, String company, String url, String detail) {
        return recordEvent(userId, runId, taskId, portal, type, title, company, url, detail, null, null);
    }

    public AgentEvent recordEvent(UUID userId, UUID runId, UUID taskId, String portal, String type,
                                  String title, String company, String url, String detail,
                                  String salary, String description) {
        AgentEvent e = new AgentEvent();
        e.setUserId(userId);
        e.setRunId(runId);
        e.setTaskId(taskId);
        e.setPortal(portal);
        e.setType(type);
        e.setTitle(title);
        e.setCompany(company);
        e.setUrl(url);
        e.setDetail(detail);
        e.setSalary(salary);
        e.setDescription(description == null ? null : (description.length() > 600 ? description.substring(0, 600) : description));
        AgentEvent saved = events.save(e);
        if (runId != null) bumpRunCounter(runId, type);
        // Surface the moments the owner actually cares about as notifications (the bell):
        // every application sent, and replies received. Searching/info stay in the activity
        // feed only — notifying those would bury the signal.
        try {
            if ("applied".equals(type) || "easy_apply".equals(type)) {
                notifications.create(userId, "agent_applied", "Applied: " + nz(title, "a job"),
                        (company == null ? "" : company + " · ") + nz(portal, "") + " — sent by the agent",
                        Map.of("url", nz(url, ""), "portal", nz(portal, "")));
            } else if ("reply_received".equals(type)) {
                notifications.create(userId, "agent_reply", "Reply received" + (company == null ? "" : " — " + company),
                        nz(detail, "A recruiter replied — open Network to respond."), Map.of("portal", nz(portal, "")));
            }
        } catch (Exception ex) {
            log.warn("notification create failed: {}", ex.getMessage());
        }
        return saved;
    }

    private static String nz(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s;
    }

    private void bumpRunCounter(UUID runId, String type) {
        runs.findById(runId).ifPresent(r -> {
            switch (type) {
                case "job_identified" -> r.setSearched(r.getSearched() + 1);
                case "relevant" -> r.setEvaluated(r.getEvaluated() + 1);
                case "applied", "easy_apply" -> r.setApplied(r.getApplied() + 1);
                case "connection_sent" -> r.setConnected(r.getConnected() + 1);
                case "message_sent" -> r.setMessaged(r.getMessaged() + 1);
                case "error" -> r.setFailed(r.getFailed() + 1);
                default -> { /* info / post_analysed: no counter */ }
            }
            runs.save(r);
        });
    }

    public List<AgentEvent> recentEvents(UUID userId, int limit) {
        return events.findByUserIdOrderByCreatedAtDesc(userId, PageRequest.of(0, limit));
    }

    /** [type, count] since a cutoff — powers the dashboard metric tiles in one query. */
    public List<Object[]> eventCountsSince(UUID userId, Instant since) {
        return events.countByTypeSince(userId, since);
    }

    // ---- live frames --------------------------------------------------------

    public void putFrame(UUID userId, UUID runId, String portal, String action, String imageB64) {
        frames.put(userId, runId, portal, action, imageB64);
    }

    public LiveFrame frame(UUID userId) {
        return frames.get(userId);
    }

    // ---- fit evaluation (worker calls this per portal job) ------------------

    /** Quick keyword fit 0-100 for a portal listing, reusing the ingest scorer. */
    public int evaluate(String title, String company, String location, String description) {
        Profile p = profiles.get();
        Job j = new Job();
        j.setTitle(title);
        j.setCompany(company);
        j.setLocation(location);
        j.setDescription(description);
        j.setRegion(regionOf(location));
        j.setPostedAt(Instant.now());
        try {
            return scorer.score(j, p);
        } catch (Exception e) {
            log.debug("evaluate failed: {}", e.getMessage());
            return 0;
        }
    }

    private String regionOf(String location) {
        if (location == null) return "unknown";
        String l = location.toLowerCase(Locale.ROOT);
        if (l.contains("remote")) return "remote";
        if (l.matches(".*(india|bengaluru|bangalore|hyderabad|chennai|mumbai|pune|delhi|noida|gurgaon|kolkata).*"))
            return "india";
        return "unknown";
    }

    // ---- schedule / search plan ---------------------------------------------

    /** The daily rotation blocks, seeding a sensible default the first time. */
    @Transactional
    public List<AgentSchedule> schedule(UUID userId) {
        List<AgentSchedule> list = schedules.findByUserIdOrderByOrdAsc(userId);
        if (!list.isEmpty()) return list;
        String[][] seed = {{"naukri", "09:00"}, {"linkedin", "11:00"}, {"indeed", "13:00"}};
        int ord = 0;
        for (String[] s : seed) {
            AgentSchedule a = new AgentSchedule();
            a.setUserId(userId);
            a.setPortal(s[0]);
            a.setOrd(ord++);
            a.setStartTime(s[1]);
            a.setDurationMins(120);
            schedules.save(a);
        }
        return schedules.findByUserIdOrderByOrdAsc(userId);
    }

    @Transactional
    public List<AgentSchedule> saveSchedule(UUID userId, List<AgentSchedule> blocks) {
        schedules.deleteByUserId(userId);
        int ord = 0;
        for (AgentSchedule b : blocks) {
            b.setId(null);
            b.setUserId(userId);
            b.setOrd(ord++);
            b.setUpdatedAt(Instant.now());
            schedules.save(b);
        }
        return schedules.findByUserIdOrderByOrdAsc(userId);
    }

    /**
     * Search keywords + locations for a portal block. Priority:
     *   1. an explicit per-portal schedule override, then
     *   2. the target roles / locations you typed in Auto Apply → Setup (the SAME source
     *      the engine uses, so the worker searches exactly what you configured), then
     *   3. a last-resort fall back to the app Profile.
     */
    public Map<String, Object> searchPlan(UUID userId, String portal) {
        Profile p = profiles.get();
        AgentSchedule block = schedules.findByUserIdOrderByOrdAsc(userId).stream()
                .filter(b -> b.getPortal().equalsIgnoreCase(portal)).findFirst().orElse(null);

        List<String> keywords = new ArrayList<>();
        List<String> locations = new ArrayList<>();

        // 1. explicit per-portal override
        if (block != null && block.getKeywords() != null && !block.getKeywords().isBlank())
            for (String k : block.getKeywords().split(",")) if (!k.isBlank()) keywords.add(k.trim());
        if (block != null && block.getLocations() != null && !block.getLocations().isBlank())
            for (String l : block.getLocations().split(",")) if (!l.isBlank()) locations.add(l.trim());

        // 2. the Setup roles/locations you actually typed (engine search-queries JSON)
        if (keywords.isEmpty() || locations.isEmpty()) {
            engineProfiles.findByUserId(userId).ifPresent(eng -> {
                if (eng.getSearchQueries() != null && !eng.getSearchQueries().isBlank()) {
                    try {
                        var n = json.readTree(eng.getSearchQueries());
                        if (keywords.isEmpty()) n.path("keywords").forEach(x -> keywords.add(x.asText()));
                        if (locations.isEmpty()) n.path("locations").forEach(x -> locations.add(x.asText()));
                    } catch (Exception ignore) { /* fall through to profile */ }
                }
            });
        }

        // 3. last-resort: the app Profile — the Job Profile's desired titles are what the
        //    candidate actually WANTS (beats their current title as a search term).
        if (keywords.isEmpty() && p.getDesiredTitles() != null && !p.getDesiredTitles().isBlank()) {
            for (String t : p.getDesiredTitles().split(",")) if (!t.isBlank()) keywords.add(t.trim());
        }
        if (keywords.isEmpty()) {
            if (p.getCurrentTitle() != null && !p.getCurrentTitle().isBlank()) keywords.add(p.getCurrentTitle().trim());
            if (p.getHeadline() != null && !p.getHeadline().isBlank()) keywords.add(p.getHeadline().trim());
            if (p.getSkills() != null) p.getSkills().stream().limit(5).forEach(keywords::add);
        }
        if (keywords.isEmpty()) keywords.add("software engineer");
        if (locations.isEmpty()) {
            if (p.getPreferredLocations() != null) locations.addAll(p.getPreferredLocations());
            if (p.getLocation() != null && !p.getLocation().isBlank()) locations.add(p.getLocation().trim());
        }
        if (locations.isEmpty()) locations.add("India");

        Map<String, Object> plan = new LinkedHashMap<>();
        plan.put("portal", portal);
        plan.put("keywords", keywords.stream().distinct().limit(6).toList());
        plan.put("locations", locations.stream().distinct().limit(6).toList());
        plan.put("applyCap", block != null ? block.getApplyCap() : 200);
        plan.put("connectCap", block != null ? block.getConnectCap() : 100);
        plan.put("messageCap", block != null ? block.getMessageCap() : 50);
        plan.put("blockMinutes", block != null ? block.getDurationMins() : 120);
        plan.put("mode", block == null || block.getMode() == null || block.getMode().isBlank()
                ? "apply" : block.getMode());
        plan.putAll(flows()); // flow toggles ride along so the worker honours them
        return plan;
    }

    /**
     * The recommended daily plan (owner's spec): Easy Apply TWICE a day per portal in
     * short slots; outreach (posts + HR emails + connections) ONCE a day with a long
     * evening slot so it lands more connections. Replaces the existing schedule.
     */
    @Transactional
    public List<AgentSchedule> applyRecommendedSchedule(UUID userId) {
        schedules.deleteAll(schedules.findByUserIdOrderByOrdAsc(userId));
        record B(String portal, String start, int mins, String mode, int applyCap) {}
        List<B> plan = List.of(
                new B("linkedin", "09:00", 60, "apply", 40),
                new B("indeed",   "10:30", 60, "apply", 40),
                new B("linkedin", "17:00", 150, "outreach", 0),
                new B("linkedin", "20:00", 60, "apply", 40),
                new B("indeed",   "21:30", 60, "apply", 40));
        List<AgentSchedule> out = new ArrayList<>();
        int ord = 0;
        for (B b : plan) {
            AgentSchedule s = new AgentSchedule();
            s.setUserId(userId);
            s.setPortal(b.portal());
            s.setOrd(ord++);
            s.setStartTime(b.start());
            s.setDurationMins(b.mins());
            s.setMode(b.mode());
            s.setApplyCap(b.applyCap());
            s.setEnabled(true);
            s.setUpdatedAt(Instant.now());
            out.add(schedules.save(s));
        }
        return out;
    }

    // ---- flow controls (owner toggles on the Connections board) ---------------

    private static final Map<String, String> FLOW_KEYS = Map.of(
            "autoMessage", "agent_auto_message",
            "autoEmail", "agent_auto_email",
            "autoEasyApply", "agent_auto_easy_apply");

    /** The three automation toggles; default ON. */
    public Map<String, Object> flows() {
        Map<String, Object> out = new LinkedHashMap<>();
        FLOW_KEYS.forEach((name, key) ->
                out.put(name, settings.get(key).map(Boolean::parseBoolean).orElse(true)));
        return out;
    }

    public void setFlow(String name, boolean value) {
        String key = FLOW_KEYS.get(name);
        if (key != null) settings.put(key, String.valueOf(value));
    }

    // ---- time-based rotation (Naukri 09:00 → LinkedIn → Indeed, unattended) ---

    private static final java.time.ZoneId ZONE = java.time.ZoneId.of("Asia/Kolkata");

    /** Which enabled schedule block covers "now", if any. */
    private AgentSchedule activeBlock(List<AgentSchedule> blocks, int nowMin) {
        for (AgentSchedule b : blocks) {
            if (!b.isEnabled() || b.getStartTime() == null) continue;
            Integer start = parseHhmm(b.getStartTime());
            if (start == null) continue;
            int end = start + Math.max(1, b.getDurationMins());
            if (nowMin >= start && nowMin < end) return b;
        }
        return null;
    }

    private static Integer parseHhmm(String s) {
        try {
            String[] p = s.trim().split(":");
            return Integer.parseInt(p[0]) * 60 + (p.length > 1 ? Integer.parseInt(p[1]) : 0);
        } catch (Exception e) {
            return null;
        }
    }

    /** Today's start-of-window instant for a block (its start time, IST), or null if unparseable. */
    private static Instant blockStartInstant(AgentSchedule block) {
        Integer start = parseHhmm(block.getStartTime());
        if (start == null) return null;
        return java.time.LocalDate.now(ZONE)
                .atTime(start / 60, start % 60)
                .atZone(ZONE)
                .toInstant();
    }

    /**
     * Start the portal whose scheduled block is active right now, if nothing is already
     * running for this user. Conservative: it never interrupts a live run — the worker's
     * own block deadline ends it, and the next tick picks up the following block. Returns
     * a short summary for the dashboard / logs.
     */
    @Transactional
    public String tickRotationForUser(UUID userId) {
        if (isPaused()) return "paused";
        List<AgentSchedule> blocks = schedules.findByUserIdOrderByOrdAsc(userId);
        if (blocks.isEmpty()) return "no schedule";
        int nowMin = java.time.LocalTime.now(ZONE).toSecondOfDay() / 60;
        AgentSchedule block = activeBlock(blocks, nowMin);
        if (block == null) return "no active block now";
        // Naukri automation is parked — never auto-start it from the rotation.
        if ("naukri".equalsIgnoreCase(block.getPortal())) return "naukri parked (in progress)";

        AgentRun live = activeRun(userId);
        if (live != null) {
            return block.getPortal().equals(live.getPortal())
                    ? "already running " + block.getPortal()
                    : "waiting — " + live.getPortal() + " still finishing";
        }

        // Start each block ONCE per window. The rotation ticks every ~5 min, so without this
        // guard a block whose run finished early (nothing to apply to / not logged in) would
        // be re-started every 5 minutes for the block's whole duration — the "0 applied" spam
        // and the "it stops and restarts every 5 minutes" the owner saw. If a run for this
        // portal already started at/after this block's start time today, don't launch another.
        Instant blockStart = blockStartInstant(block);
        if (blockStart != null && runs.existsByUserIdAndPortalAndCreatedAtGreaterThanEqual(
                userId, block.getPortal(), blockStart)) {
            return block.getPortal() + " already ran this block";
        }

        startOrGetRun(userId, block.getPortal());
        log.info("Rotation started {} for user {}", block.getPortal(), userId);
        return "started " + block.getPortal();
    }

    /** Scheduler entry point — advance the rotation for every user that has a schedule. */
    @Transactional
    public void tickRotation() {
        if (isPaused()) return;
        java.util.Set<UUID> users = new java.util.LinkedHashSet<>();
        for (AgentSchedule b : schedules.findAll()) users.add(b.getUserId());
        for (UUID u : users) {
            try {
                tickRotationForUser(u);
            } catch (Exception e) {
                log.warn("rotation tick failed for {}: {}", u, e.getMessage());
            }
        }
    }

    // ---- Network CRM: contacts + draft-first messaging ----------------------

    public List<PortalContact> contacts(UUID userId, int limit) {
        return contacts.findByUserIdOrderByUpdatedAtDesc(userId, PageRequest.of(0, limit));
    }

    /** A single contact, scoped to the owner (null if missing or not theirs). */
    public PortalContact contactById(UUID userId, UUID contactId) {
        if (contactId == null) return null;
        return contacts.findById(contactId).filter(c -> c.getUserId().equals(userId)).orElse(null);
    }

    // ---- connection outreach (invite → accept → message with résumé) ----------

    /** Contacts we've sent an invite to and are waiting on — the worker checks these for acceptance. */
    public List<PortalContact> pendingConnections(UUID userId) {
        return contacts.findByUserIdAndConnectionStatusOrderByUpdatedAtDesc(userId, "pending", PageRequest.of(0, 100));
    }

    /** Move a contact along the invite lifecycle: none → pending → connected. */
    @Transactional
    public PortalContact setConnectionStatus(UUID userId, UUID contactId, String status) {
        PortalContact c = contacts.findById(contactId).orElseThrow();
        if (!c.getUserId().equals(userId)) throw new IllegalStateException("not your contact");
        c.setConnectionStatus(status);
        if ("connection_sent".equals(status)) c.setConnectionStatus("pending");
        c.setUpdatedAt(Instant.now());
        return contacts.save(c);
    }

    /**
     * The short note that rides along with a connection request. Rendered from the owner's
     * template (or a sensible default) and — when AI is on — rewritten for higher acceptance,
     * kept under LinkedIn's ~300-char note limit and never fabricating anything.
     */
    public String connectionNote(UUID userId, UUID contactId) {
        PortalContact c = contactId == null ? null : contacts.findById(contactId).orElse(null);
        Profile p = profiles.get();
        String template = messageTemplate();
        String first = c == null || c.getName() == null || c.getName().isBlank()
                ? "there" : c.getName().trim().split("\\s+")[0];
        String base = !template.isBlank() ? renderTemplate(template, c, p)
                : "Hi " + first + ", I'm " + nz(p.getFullName()) + ", a " + nz(p.getCurrentTitle())
                  + ". I'd love to connect regarding relevant openings"
                  + (c != null && c.getCompany() != null && !c.getCompany().isBlank() ? " at " + c.getCompany() : "") + ".";
        if (ai.isEnabled()) {
            String sys = """
                    Rewrite this LinkedIn connection note for a higher acceptance rate: warm, specific,
                    human, first person, UNDER 280 characters, no clichés, no fabricated facts. Keep any
                    real name/role/company. Output ONLY the note text.""";
            String user = "CANDIDATE: " + nz(p.getFullName()) + " — " + nz(p.getCurrentTitle())
                    + "\nCONTACT: " + (c == null ? "a recruiter" : nz(c.getName()) + " at " + nz(c.getCompany()))
                    + "\nDRAFT: " + base;
            String opt = nz(ai.complete(sys, user, true, false)).trim();
            if (!opt.isBlank() && opt.length() <= 300) base = opt;
        }
        return base.length() > 300 ? base.substring(0, 297) + "…" : base;
    }

    @Transactional
    public PortalContact upsertContact(UUID userId, String portal, String name, String profileUrl,
                                       String company, String role, String sourceJobUrl) {
        PortalContact c = contacts.findByUserIdAndPortalAndProfileUrl(userId, portal, profileUrl)
                .orElseGet(PortalContact::new);
        c.setUserId(userId);
        c.setPortal(portal);
        if (name != null) c.setName(name);
        c.setProfileUrl(profileUrl);
        if (company != null) c.setCompany(company);
        if (role != null) c.setRole(role);
        if (sourceJobUrl != null) c.setSourceJobUrl(sourceJobUrl);
        c.setUpdatedAt(Instant.now());
        return contacts.save(c);
    }

    /**
     * An HR email harvested from a hiring post. Returns the contact, or null when this
     * email is already known — the caller must NOT auto-apply twice to the same address.
     */
    @Transactional
    public PortalContact recordHrLead(UUID userId, String portal, String name, String email,
                                      String postUrl, String title) {
        if (contacts.findFirstByUserIdAndEmailIgnoreCase(userId, email).isPresent()) return null;
        PortalContact c = new PortalContact();
        c.setUserId(userId);
        c.setPortal(nz(portal, "linkedin"));
        c.setName(nz(name, email));
        c.setEmail(email);
        c.setProfileUrl(postUrl);
        c.setRole(title);
        c.setConnectionStatus("lead");
        c.setUpdatedAt(Instant.now());
        PortalContact saved = contacts.save(c);
        recordEvent(userId, null, null, portal, "info",
                "HR email found: " + email, null, postUrl, nz(title, "hiring post"));
        try {
            notifications.create(userId, "agent_reply", "HR email found — " + email,
                    nz(title, "From a hiring post") + (postUrl == null ? "" : " · " + postUrl),
                    Map.of("email", email));
        } catch (Exception ex) { log.warn("lead notification failed: {}", ex.getMessage()); }
        return saved;
    }

    /**
     * A recruiter replied. We only LOG it, flag the contact as replied, and notify the
     * owner — the automation deliberately does NOT draft or send a response. The owner
     * takes the conversation from here (that's the point: the automation lays the
     * foundation — connection + first message — and hands off to a human for the reply).
     */
    @Transactional
    public AgentMessage recordIncomingReply(UUID userId, UUID contactId, String incoming) {
        PortalContact c = contactId == null ? null : contacts.findById(contactId).orElse(null);
        AgentMessage in = new AgentMessage();
        in.setUserId(userId);
        in.setContactId(contactId);
        in.setPortal(c == null ? null : c.getPortal());
        in.setDirection("in");
        in.setBody(incoming);
        in.setStatus("received");
        AgentMessage saved = messages.save(in);
        if (c != null) { c.setConnectionStatus("replied"); c.setLastMessageAt(Instant.now()); contacts.save(c); }
        recordEvent(userId, null, null, c == null ? null : c.getPortal(), "reply_received",
                (c == null ? "A recruiter" : nz(c.getName(), "A recruiter")) + " replied",
                c == null ? null : c.getCompany(), c == null ? null : c.getProfileUrl(),
                incoming.length() > 140 ? incoming.substring(0, 140) + "…" : incoming);
        try {
            notifications.create(userId, "agent_reply", "Recruiter replied — reply from your own account",
                    (c == null ? "" : nz(c.getName(), "") + (c.getCompany() == null ? "" : " · " + c.getCompany()) + " — ")
                            + (incoming.length() > 160 ? incoming.substring(0, 160) + "…" : incoming),
                    Map.of("contactId", String.valueOf(contactId)));
        } catch (Exception ex) { log.warn("reply notification failed: {}", ex.getMessage()); }
        return saved;
    }

    public List<AgentMessage> messages(UUID userId, String status, int limit) {
        return status == null
                ? messages.findByUserIdOrderByUpdatedAtDesc(userId, PageRequest.of(0, limit))
                : messages.findByUserIdAndStatusOrderByUpdatedAtDesc(userId, status, PageRequest.of(0, limit));
    }

    public long pendingApprovals(UUID userId) {
        return messages.countByUserIdAndStatus(userId, "pending_approval");
    }

    public List<AgentMessage> approvedOutgoing(UUID userId) {
        return messages.findByUserIdAndStatusOrderByUpdatedAtDesc(userId, "approved", PageRequest.of(0, 50));
    }

    private static final String MSG_TEMPLATE_KEY = "agent_message_template";

    /** The owner's connection/outreach message template ([Name]/[Role]/[Company] fill in). */
    public String messageTemplate() {
        return settings.get(MSG_TEMPLATE_KEY).orElse("");
    }

    public void setMessageTemplate(String template) {
        settings.put(MSG_TEMPLATE_KEY, template == null ? "" : template.trim());
    }

    /** Render the owner's template for a contact — [Name], [Role], [Company], [MyName], [MyRole]. */
    private String renderTemplate(String template, PortalContact c, Profile p) {
        String firstName = c == null || c.getName() == null || c.getName().isBlank()
                ? "there" : c.getName().trim().split("\\s+")[0];
        return template
                .replace("[Name]", firstName)
                .replace("[Role]", c == null ? "your team's roles" : nz(c.getRole(), "your team's roles"))
                .replace("[Company]", c == null ? "your company" : nz(c.getCompany(), "your company"))
                .replace("[MyName]", nz(p.getFullName(), ""))
                .replace("[MyRole]", nz(p.getCurrentTitle(), nz(p.getHeadline(), "")));
    }

    /**
     * Outbound OUTREACH only (connection notes / intros). When the owner saved a TEMPLATE
     * and Auto-message is ON, the note is rendered + auto-approved so the worker sends it
     * without waiting; otherwise it's drafted for approval.
     *
     * Recruiter REPLIES are handled separately by {@link #recordIncomingReply} — the
     * automation NEVER drafts or sends a reply. The owner replies to real conversations.
     */
    @Transactional
    public AgentMessage draftMessage(UUID userId, UUID contactId, String incoming, String kind) {
        // A reply came in → just log it + notify; no outbound automation whatsoever.
        if (incoming != null && !incoming.isBlank()) {
            return recordIncomingReply(userId, contactId, incoming);
        }

        PortalContact c = contactId == null ? null : contacts.findById(contactId).orElse(null);
        Profile p = profiles.get();
        String template = messageTemplate();
        boolean autoMessage = Boolean.TRUE.equals(flows().get("autoMessage"));

        // Owner's template + Auto-message ON → render (+ optional AI polish for reach) and
        // auto-approve, so the worker can send it with the résumé attached.
        if (autoMessage && !template.isBlank()) {
            String body = renderTemplate(template, c, p);
            boolean polished = false;
            if (ai.isEnabled()) {
                String sys = """
                        Rewrite this LinkedIn direct message to a new connection for a higher reply rate:
                        warm, specific, first person, 40-90 words. The candidate is ATTACHING their résumé,
                        so it may briefly reference that. No clichés, no fabricated facts. Output ONLY the message.""";
                String user = "CANDIDATE: " + nz(p.getFullName()) + " — " + nz(p.getCurrentTitle())
                        + "\nCONTACT: " + (c == null ? "a recruiter" : nz(c.getName()) + " at " + nz(c.getCompany()))
                        + "\nDRAFT: " + body;
                String opt = nz(ai.complete(sys, user, false, false)).trim();
                if (!opt.isBlank()) { body = opt; polished = true; }
            }
            AgentMessage m = new AgentMessage();
            m.setUserId(userId);
            m.setContactId(contactId);
            m.setPortal(c == null ? null : c.getPortal());
            m.setDirection("out");
            m.setBody(body);
            m.setStatus("approved");
            m.setAiDrafted(polished);
            return messages.save(m);
        }

        String draft;
        if (ai.isEnabled()) {
            String sys = """
                    You draft short, warm, professional connection/intro notes a job seeker sends
                    to a recruiter/hiring contact. 40-70 words, first person, specific, no clichés,
                    no fabricated facts. Output only the message text.""";
            String user = "CANDIDATE: " + nz(p.getFullName()) + " — " + nz(p.getCurrentTitle())
                    + "\nSKILLS: " + (p.getSkills() == null ? "" : String.join(", ", p.getSkills()))
                    + "\nCONTACT: " + (c == null ? "recruiter" : nz(c.getName()) + " at " + nz(c.getCompany()))
                    + "\nKIND: " + nz(kind)
                    + "\nGOAL: a brief connection/intro note about fit for their roles.";
            draft = nz(ai.complete(sys, user, false, false)).trim();
        } else {
            draft = "Hi" + (c != null && c.getName() != null ? " " + c.getName().split(" ")[0] : "")
                    + ", I'm " + nz(p.getFullName()) + ", a " + nz(p.getCurrentTitle())
                    + ". I'd love to connect regarding relevant openings on your team.";
        }

        AgentMessage m = new AgentMessage();
        m.setUserId(userId);
        m.setContactId(contactId);
        m.setPortal(c == null ? null : c.getPortal());
        m.setDirection("out");
        m.setBody(draft);
        m.setStatus("pending_approval");
        m.setAiDrafted(ai.isEnabled());
        return messages.save(m);
    }

    @Transactional
    public AgentMessage setMessageStatus(UUID userId, UUID messageId, String status, String editedBody) {
        AgentMessage m = messages.findById(messageId).orElseThrow();
        if (!m.getUserId().equals(userId)) throw new IllegalStateException("not your message");
        if (editedBody != null && !editedBody.isBlank()) m.setBody(editedBody);
        m.setStatus(status);
        m.setUpdatedAt(Instant.now());
        return messages.save(m);
    }

    @Transactional
    public void markMessageSent(UUID userId, UUID messageId) {
        AgentMessage m = messages.findById(messageId).orElseThrow();
        if (!m.getUserId().equals(userId)) throw new IllegalStateException("not your message");
        m.setStatus("sent");
        m.setUpdatedAt(Instant.now());
        messages.save(m);
        if (m.getContactId() != null) contacts.findById(m.getContactId()).ifPresent(c -> {
            c.setLastMessageAt(Instant.now());
            if ("none".equals(c.getConnectionStatus())) c.setConnectionStatus("pending");
            contacts.save(c);
        });
    }

    private static String nz(String s) { return s == null ? "" : s; }
}
