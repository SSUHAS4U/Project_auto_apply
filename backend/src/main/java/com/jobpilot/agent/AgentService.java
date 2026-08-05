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

    // The portals the automation actually drives. Naukri was removed 2026-08-04: its adapter
    // was never wired into the worker, the API rejected naukri runs, and the Connections page
    // never offered it — so seeding a row here only created a connection nobody could use.
    private static final List<String> PORTALS = List.of("linkedin", "indeed");

    /** Titles the automation must never apply to, whatever the search returns. */
    private static final List<String> EXCLUDE_TITLES = List.of(
            "senior", "sr.", "lead", "principal", "staff", "architect",
            "manager", "director", "head of", "vp", "vice president");

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
        return recordEvent(userId, runId, taskId, portal, type, title, company, url, detail,
                salary, description, null);
    }

    /** @param flow which of the four automations produced this, for per-flow counting. */
    public AgentEvent recordEvent(UUID userId, UUID runId, UUID taskId, String portal, String type,
                                  String title, String company, String url, String detail,
                                  String salary, String description, String flow) {
        AgentEvent e = new AgentEvent();
        e.setFlow(flow);
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
        String[][] seed = {{"linkedin", "11:00"}, {"indeed", "13:00"}};
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

        boolean indeed = portal.equalsIgnoreCase("indeed");
        Map<String, Object> plan = new LinkedHashMap<>();
        plan.put("portal", portal);
        // Read the settings ONCE for the whole plan. This used to call limits() three times —
        // via cfgFor() twice and again below — tripling an already expensive read.
        Map<String, Object> cfg = limits();
        int maxKw = intSetting(cfg.get("maxKeywords"), 12);
        int maxLoc = intSetting(cfg.get("maxLocations"), 6);
        plan.put("keywords", expandQueries(keywords, p, maxKw));
        plan.put("locations", locations.stream().distinct().limit(maxLoc).toList());
        // DAILY QUOTA, not a per-run number. The gear sets how many applications you want on
        // this portal PER DAY; each run is allowed however many of those are still outstanding.
        // So a run that only manages 6 of 20 leaves 14 for the next run — the shortfall carries
        // forward automatically instead of being lost, and once the day's quota is met the run
        // spends all its time on outreach instead of applying.
        int dailyTarget = applyCapFor(portal);
        long doneToday = events.countAppliedSince(userId, portal, startOfTodayUtc());
        int remaining = (int) Math.max(0, dailyTarget - doneToday);
        plan.put("applyCap", remaining);
        plan.put("dailyTarget", dailyTarget);
        plan.put("appliedToday", doneToday);
        plan.put("connectCap", 1000);
        plan.put("messageCap", 1000);
        // Durations come from the cadence settings (Automation → Schedule), not from a start-time
        // schedule row: LinkedIn runs applyMins of Easy Apply then outreachMins of outreach;
        // Indeed runs indeedMins. restMins is how long the app waits between blocks.
        // ONE source of truth for LinkedIn timings: the four flow budgets. There used to be a
        // second pair — "Easy Apply time" and "Outreach time" — describing the same durations,
        // and the flow settings lost: Phase 1 read linkedinApplyMins while easyApplyOn/Mins were
        // never read at all, so switching Easy Apply off in the UI did nothing.
        int liApply = intSetting(cfg.get("easyApplyOn"), 1) == 0 ? 0 : intSetting(cfg.get("easyApplyMins"), 90);
        int liOutreach = 0;
        for (String[] f : FLOWS) {
            if ("easyApply".equals(f[0])) continue;
            if (Boolean.FALSE.equals(cfg.get(f[0] + "On"))) continue;
            liOutreach += intSetting(cfg.get(f[0] + "Mins"), 30);
        }
        plan.put("phase1Minutes", liApply);
        plan.put("restMinutes", cfg.get("restMins"));
        plan.put("blockMinutes", indeed ? (int) cfg.get("indeedMins") : liApply + liOutreach);
        plan.put("mode", block == null || block.getMode() == null || block.getMode().isBlank()
                ? "apply" : block.getMode());
        // The gates. Sent with the plan so the worker enforces the same numbers the dashboard
        // shows, and so they can be retuned without shipping a new desktop build.
        plan.put("fitMin", cfg.get("fitMin"));
        plan.put("personConfMin", cfg.get("personConfMin"));
        plan.put("maxAgeDays", cfg.get("maxAgeDays"));
        plan.put("postScanTarget", cfg.get("postScanTarget"));
        // Invitation capacity. LinkedIn counts PENDING invitations against the weekly limit and
        // stops offering Connect once you are over it, so the connections flow withdraws the
        // oldest ones weekly. The worker enforces a hard 14-day floor on top of this.
        plan.put("withdrawAfterDays", cfg.get("withdrawAfterDays"));
        plan.put("withdrawMax", cfg.get("withdrawMax"));
        // Each flow's on/off + minutes, as one object the worker can iterate.
        Map<String, Object> flowCfg = new LinkedHashMap<>();
        for (String[] f : FLOWS) {
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("on", cfg.get(f[0] + "On"));
            one.put("mins", cfg.get(f[0] + "Mins"));
            one.put("label", f[1]);
            flowCfg.put(f[0], one);
        }
        plan.put("flowConfig", flowCfg);
        plan.put("pagesPerSearch", cfg.get("pagesPerSearch"));
        // Titles the worker must never apply to. Sent as data so the rule is visible and
        // tunable, instead of being a regex frozen inside two separate portal adapters.
        plan.put("excludeTitles", EXCLUDE_TITLES);
        plan.putAll(flows()); // flow toggles ride along so the worker honours them
        return plan;
    }

    /**
     * Widen the search without making it random.
     *
     * One keyword per target role found the same ~16 postings on every city. This pairs each role
     * with the candidate's strongest skills to produce extra, still-relevant queries ("Full Stack
     * Developer Java", "Full Stack Developer React"), which is how a human searches when the first
     * page runs dry. Deterministic throughout: the inputs are ordered, the output is de-duplicated
     * and sorted, so the same profile always searches the same terms in the same order.
     */
    /**
     * Tools so common they appear on most postings regardless of stack. Pairing one with a role
     * shrinks the result set without improving relevance — see the measurements in
     * {@link #expandQueries(List, Profile, int)}. Keeping this as a deny-list rather than an
     * allow-list means a genuine stack term nobody thought to enumerate still gets through.
     */
    private static final Set<String> NON_DIFFERENTIATING = Set.of(
            "git", "github", "gitlab", "bitbucket", "bootstrap", "html", "html5", "css", "css3",
            "jquery", "json", "xml", "yaml", "rest", "restful", "api", "apis", "crud",
            "agile", "scrum", "kanban", "jira", "confluence", "trello",
            "linux", "unix", "windows", "macos", "bash", "shell",
            "excel", "word", "powerpoint", "outlook",
            "npm", "yarn", "maven", "gradle", "webpack", "babel", "eslint",
            "vscode", "eclipse", "intellij", "postman", "swagger",
            "oop", "oops", "dsa", "algorithms", "debugging", "testing");

    List<String> expandQueries(List<String> roles, Profile p) {
        return expandQueries(roles, p, 12);
    }

    List<String> expandQueries(List<String> roles, Profile p, int max) {
        LinkedHashSet<String> base = new LinkedHashSet<>();
        roles.stream().map(String::trim).filter(s -> !s.isBlank()).forEach(base::add);
        if (base.isEmpty()) base.add("software engineer");

        // Only skills that name a technology are useful as query modifiers; "communication" or
        // "teamwork" would drag in noise, so anything long or multi-word is left out.
        //
        // …and being a technology is not enough: it has to NARROW THE FIELD USEFULLY. Measured
        // against live in.indeed.com for Bengaluru:
        //     "Backend Developer"            -> 300 postings
        //     "Backend Developer Java"       -> 100
        //     "Backend Developer Git"        -> 100
        //     "Backend Developer Bootstrap"  ->  25
        // Git and Bootstrap are on half the postings in the market; pairing them with a role
        // doesn't find better-matched jobs, it just discards every posting that didn't happen
        // to spell out a ubiquitous tool. A real run searched "Backend Developer Bootstrap"
        // and that is not a search anybody would type.
        List<String> techSkills = (p.getSkills() == null ? List.<String>of() : p.getSkills()).stream()
                .map(s -> s == null ? "" : s.trim())
                .filter(s -> s.length() >= 2 && s.length() <= 18 && !s.contains(" "))
                .filter(s -> !NON_DIFFERENTIATING.contains(s.toLowerCase()))
                .distinct().limit(6).toList();

        LinkedHashSet<String> out = new LinkedHashSet<>(base);
        for (String role : base) {
            for (String skill : techSkills) {
                if (role.toLowerCase().contains(skill.toLowerCase())) continue;  // already implied
                out.add(role + " " + skill);
            }
        }
        // Stable order so two runs of the same profile search identically.
        List<String> sorted = new ArrayList<>(out);
        sorted.sort(String::compareToIgnoreCase);
        return sorted.stream().limit(Math.max(1, max)).toList();
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

    // ---- per-run apply caps (the gear icon on the LinkedIn / Indeed pages) --------
    private static final String LI_CAP_KEY = "agent_linkedin_apply_cap";
    private static final String IN_CAP_KEY = "agent_indeed_apply_cap";

    // How long each phase runs and how long the automation rests between blocks. These replace
    // the old start-time schedule: you no longer say WHEN it runs (it runs whenever the app is
    // open) — you say HOW MUCH of each thing it does.
    // agent_linkedin_apply_mins / agent_linkedin_outreach_mins were removed: they described the
    // same durations as the per-flow budgets and disagreed with them. Old rows are simply
    // ignored; the flow settings are the only source of LinkedIn timings now.
    private static final String IN_MINS = "agent_indeed_mins";
    private static final String REST_MINS = "agent_rest_mins";
    /** Minimum résumé-compatibility score before the worker may apply. */
    private static final String FIT_MIN = "agent_fit_min";
    /** Minimum confidence before the worker may contact a person. */
    private static final String PERSON_CONF_MIN = "agent_person_conf_min";
    /** Ignore postings older than this many days. */
    private static final String MAX_AGE_DAYS = "agent_max_age_days";
    private static final String WITHDRAW_AFTER_DAYS = "agent_withdraw_after_days";
    private static final String WITHDRAW_MAX = "agent_withdraw_max";
    /** How many hiring posts to read per day. */
    private static final String POST_SCAN_TARGET = "agent_post_scan_target";
    /** Result pages to walk per search, per portal. */
    private static final String PAGES_PER_SEARCH = "agent_pages_per_search";
    /** How many keyword variants / locations a search plan may use. */
    private static final String MAX_KEYWORDS = "agent_max_keywords";
    private static final String MAX_LOCATIONS = "agent_max_locations";
    /** LinkedIn blocks/day that may run purely for outreach once the apply quota is met. */
    private static final String OUTREACH_BLOCKS = "agent_outreach_blocks_day";
    /** Days between follow-up touches 1..4. */
    private static final String FU1 = "agent_followup_1";
    private static final String FU2 = "agent_followup_2";
    private static final String FU3 = "agent_followup_3";
    private static final String FU4 = "agent_followup_4";

    /**
     * The four LinkedIn automations, each independently switchable with its own time budget.
     * They were one monolithic block, so "outreach didn't work" could mean any of four different
     * things and there was no way to run just the one you cared about.
     */
    static final String[][] FLOWS = {
            // key,           label,                     default on, default minutes
            { "easyApply",    "Easy Apply",              "true",  "90"  },
            { "postApply",    "Post scan & apply",       "true",  "60"  },
            { "emailOutreach","Recruiter emails",        "true",  "30"  },
            { "connections",  "Connections & messages",  "true",  "45"  },
    };

    public Map<String, Object> limits() {
        // ONE query, not 23. Every value below used to be its own settings.get() → findById(),
        // and searchPlan called this three times — so rendering the Schedule tab cost ~100
        // round-trips to a database in another region. That is the whole reason it felt slow.
        Map<String, String> raw = settings.getAll();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("linkedinApplyCap", intOr(raw, LI_CAP_KEY, 20));
        m.put("indeedApplyCap", intOr(raw, IN_CAP_KEY, 20));
        m.put("indeedMins", intOr(raw, IN_MINS, 120));
        m.put("restMins", intOr(raw, REST_MINS, 30));
        // The gates that decide what gets applied to and who gets contacted.
        // 50, not 75. At 75 a real run skipped all 57 matches — including "fit 70 — skills
        // match web development requirements", which is a job worth an application. The gate
        // still requires techMatch, so the stack check does the protecting; the score only
        // decides how strong a match has to be, and 75 was set without evidence.
        m.put("fitMin", intOr(raw, FIT_MIN, 50));
        m.put("personConfMin", intOr(raw, PERSON_CONF_MIN, 80));
        // NOTE for anyone tuning this: LinkedIn honours any value (f_TPR takes raw seconds),
        // but INDEED accepts only the four its own filter offers — 1, 3, 7, 14. Sending
        // anything else, including this 30, made Indeed answer every search with
        // HTTP 403 "Additional Verification Required" rather than results. The Indeed adapter
        // therefore rounds this down to the nearest accepted value; see searchUrl() there.
        m.put("maxAgeDays", intOr(raw, MAX_AGE_DAYS, 30));
        // Only invitations older than this are withdrawn; the worker refuses anything under 14
        // days regardless, because withdrawing blocks re-inviting that person for ~3 weeks.
        m.put("withdrawAfterDays", intOr(raw, WITHDRAW_AFTER_DAYS, 21));
        m.put("withdrawMax", intOr(raw, WITHDRAW_MAX, 40));
        // Volume + breadth. These were constants in the worker, so changing them used to mean a
        // new desktop build — the slowest possible way to tune an automation.
        m.put("postScanTarget", intOr(raw, POST_SCAN_TARGET, 150));
        m.put("pagesPerSearch", intOr(raw, PAGES_PER_SEARCH, 3));
        m.put("maxKeywords", intOr(raw, MAX_KEYWORDS, 12));
        m.put("maxLocations", intOr(raw, MAX_LOCATIONS, 6));
        m.put("outreachBlocksPerDay", intOr(raw, OUTREACH_BLOCKS, 3));
        // The follow-up sequence, in days after the previous touch.
        m.put("followUp1", intOr(raw, FU1, 1));
        m.put("followUp2", intOr(raw, FU2, 2));
        m.put("followUp3", intOr(raw, FU3, 5));
        m.put("followUp4", intOr(raw, FU4, 10));
        // Per-flow switches and budgets.
        for (String[] f : FLOWS) {
            String on = raw.get("agent_flow_" + f[0] + "_on");
            m.put(f[0] + "On", on == null ? Boolean.parseBoolean(f[2]) : Boolean.parseBoolean(on));
            m.put(f[0] + "Mins", intOr(raw, "agent_flow_" + f[0] + "_mins", Integer.parseInt(f[3])));
        }
        return m;
    }

    /** A setting as an int, tolerating a missing or unparseable value. */
    private static int intOr(Map<String, String> raw, String key, int fallback) {
        String v = raw.get(key);
        if (v == null || v.isBlank()) return fallback;
        try { return Integer.parseInt(v.trim()); } catch (NumberFormatException e) { return fallback; }
    }

    /** Save any subset of the cadence settings; each is clamped to something sane. */
    public Map<String, Object> setLimits(Map<String, Object> body) {
        putInt(body, "linkedinApplyCap", LI_CAP_KEY, 1, 200);
        putInt(body, "indeedApplyCap", IN_CAP_KEY, 1, 200);
        putInt(body, "indeedMins", IN_MINS, 10, 480);
        putInt(body, "restMins", REST_MINS, 0, 240);
        putInt(body, "fitMin", FIT_MIN, 0, 100);
        putInt(body, "personConfMin", PERSON_CONF_MIN, 0, 100);
        putInt(body, "maxAgeDays", MAX_AGE_DAYS, 1, 365);
        // Floor of 14 mirrors the worker's own guard: two places must agree that a recent
        // invitation is never withdrawn, because only one of them is easy to change.
        putInt(body, "withdrawAfterDays", WITHDRAW_AFTER_DAYS, 14, 365);
        putInt(body, "withdrawMax", WITHDRAW_MAX, 1, 200);
        putInt(body, "postScanTarget", POST_SCAN_TARGET, 0, 1000);
        putInt(body, "pagesPerSearch", PAGES_PER_SEARCH, 1, 10);
        putInt(body, "maxKeywords", MAX_KEYWORDS, 1, 40);
        putInt(body, "maxLocations", MAX_LOCATIONS, 1, 20);
        putInt(body, "outreachBlocksPerDay", OUTREACH_BLOCKS, 0, 12);
        putInt(body, "followUp1", FU1, 0, 60);
        putInt(body, "followUp2", FU2, 0, 60);
        putInt(body, "followUp3", FU3, 0, 60);
        putInt(body, "followUp4", FU4, 0, 60);
        for (String[] f : FLOWS) {
            Object on = body == null ? null : body.get(f[0] + "On");
            if (on instanceof Boolean bo) settings.put("agent_flow_" + f[0] + "_on", String.valueOf(bo));
            putInt(body, f[0] + "Mins", "agent_flow_" + f[0] + "_mins", 0, 480);
        }
        return limits();
    }

    private void putInt(Map<String, Object> body, String field, String key, int min, int max) {
        Object v = body == null ? null : body.get(field);
        if (!(v instanceof Number n)) return;
        settings.put(key, String.valueOf(Math.max(min, Math.min(n.intValue(), max))));
    }

    /** Midnight in the user's working day. The VM runs UTC; IST is the operating timezone. */
    private static Instant startOfTodayUtc() {
        java.time.ZoneId zone = java.time.ZoneId.of("Asia/Kolkata");
        return java.time.LocalDate.now(zone).atStartOfDay(zone).toInstant();
    }

    private int applyCapFor(String portal) {
        return portal.equalsIgnoreCase("indeed")
                ? settings.get(IN_CAP_KEY).map(Integer::parseInt).orElse(20)
                : settings.get(LI_CAP_KEY).map(Integer::parseInt).orElse(20);
    }

    public void setFlow(String name, boolean value) {
        String key = FLOW_KEYS.get(name);
        if (key != null) settings.put(key, String.valueOf(value));
    }

    // ---- quota-driven rotation (starts on app-open, not on a clock) -----------
    //
    // `activeBlock`, `parseHhmm` and `blockStartInstant` lived here to decide which clock-time
    // AgentSchedule window was open. v86 replaced that trigger with quota + rest, so they had
    // no callers left — removed rather than kept as a second, contradictory answer to "when
    // does a run start". Schedule rows still exist for per-portal keyword/location overrides.

    private static final java.time.ZoneId ZONE = java.time.ZoneId.of("Asia/Kolkata");



    /**
     * Start whatever work is still owed today, if nothing is already running.
     *
     * This used to require an {@code AgentSchedule} row whose clock-time window was open right
     * now — while the Schedule tab told the owner there were no start times to set. A user who
     * configured everything correctly could sit there while nothing ever started, with no
     * visible reason. The trigger is now what the UI has always claimed: the app being open,
     * plus outstanding daily quota.
     *
     * Guards, in order: paused → desktop actually running → nothing already live → the rest
     * window has elapsed → some portal still owes work.
     */
    @Transactional
    public String tickRotationForUser(UUID userId) {
        if (isPaused()) return "paused";

        // BEFORE the online check, because "the worker is gone" is exactly when this matters.
        // A run only advances while a worker drives it, so a live run with no worker behind it
        // is finished whether the database says so or not. Left alone it blocks the rotation
        // permanently — and silently: the dashboard reads "running" and nothing ever happens
        // again. That is almost certainly why Indeed appeared never to work, since one
        // abandoned LinkedIn run is enough to stop the whole queue.
        reapStaleRuns(userId);

        // No worker, no new run. Queueing something nothing can pick up just leaves a phantom
        // "queued" on the dashboard.
        if (!isWorkerOnline(userId)) return "JobPilot Desktop isn't running";

        AgentRun live = activeRun(userId);
        if (live != null) return "already running " + live.getPortal();

        // Rest between blocks, so finishing one doesn't immediately start the next.
        int restMins = intSetting(limits().get("restMins"), 30);
        Instant lastEnd = lastFinishedAt(userId);
        if (lastEnd != null && lastEnd.isAfter(Instant.now().minusSeconds(restMins * 60L))) {
            return "resting (" + restMins + "m between blocks)";
        }

        String portal = nextPortalWithWork(userId);
        if (portal == null) return "all of today's quotas are met";

        startOrGetRun(userId, portal);
        log.info("Rotation started {} for user {}", portal, userId);
        return "started " + portal;
    }

    // ---- "when did it run / when does it run next" --------------------------

    /**
     * What the LinkedIn / Indeed page shows next to its activity feed: whether a run is live
     * right now and since when, how the last one finished, and when the next window opens.
     *
     * Deliberately derived from the SAME schedule and the same "already ran this block" guard
     * the rotation uses, so the card cannot drift from what the automation actually does.
     */
    public Map<String, Object> runInfo(UUID userId, String portal) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("portal", portal);
        m.put("paused", isPaused());
        m.put("workerOnline", isWorkerOnline(userId));

        AgentRun live = activeRun(userId);
        boolean isMine = live != null && portal.equalsIgnoreCase(live.getPortal());
        m.put("current", isMine ? runMap(live) : null);
        // A live run on the OTHER portal is why this one isn't starting — name it, rather than
        // showing a "next run" time that the rotation will refuse to honour anyway.
        m.put("busyWith", live != null && !isMine ? live.getPortal() : null);

        m.put("previous", runs.findFirstByUserIdAndPortalAndStatusInOrderByCreatedAtDesc(
                userId, portal, List.of("done", "failed")).map(this::runMap).orElse(null));

        // Paused means nothing is coming until it's resumed — don't promise a time.
        m.put("nextAt", isPaused() ? null : nextWindowStart(userId, portal, Instant.now()));
        // Which portal the rotation would actually start next. When it isn't this one, the card
        // says "after the <other> run" instead of inventing a clock time it cannot know.
        m.put("nextPortal", isPaused() || !isWorkerOnline(userId) ? null : nextPortalWithWork(userId));
        m.put("quotaMet", !portalOwesWork(userId, portal, startOfTodayUtc()));
        return m;
    }

    private Map<String, Object> runMap(AgentRun r) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", r.getId().toString());
        m.put("status", r.getStatus());
        // startedAt is only set once a worker picks the run up; fall back so a queued run
        // still reports the moment it was created rather than an empty timestamp.
        m.put("startedAt", r.getStartedAt() != null ? r.getStartedAt() : r.getCreatedAt());
        m.put("endedAt", r.getEndedAt());
        m.put("currentAction", r.getCurrentAction());
        m.put("searched", r.getSearched());
        m.put("applied", r.getApplied());
        m.put("connected", r.getConnected());
        m.put("messaged", r.getMessaged());
        m.put("failed", r.getFailed());
        return m;
    }

    /**
     * Which portal is owed work right now, or null when the day is done.
     *
     * Whichever portal ran least recently goes first, so one can't starve the other across a
     * long day. LinkedIn stays eligible for a bounded number of blocks after its apply quota is
     * met, because its second phase is outreach — stopping it dead at 20 applications would
     * silently switch off connections and HR emails for the rest of the day.
     */
    String nextPortalWithWork(UUID userId) {
        Instant dayStart = startOfTodayUtc();
        String best = null;
        Instant bestLastRun = null;
        for (String portal : List.of("linkedin", "indeed")) {
            if (!portalOwesWork(userId, portal, dayStart)) continue;
            // Never run = maximally starved. EPOCH rather than null keeps this to one
            // comparison; the previous version let a LATER never-run portal overwrite an
            // earlier one, so with no history at all the winner was simply whichever came
            // last in the list — and the two portals' "next run" answers flipped arbitrarily.
            Instant last = runs.findFirstByUserIdAndPortalOrderByCreatedAtDesc(userId, portal)
                    .map(AgentRun::getCreatedAt).orElse(Instant.EPOCH);
            // Strictly earlier only, so a tie deterministically keeps the first in the list.
            if (best == null || last.isBefore(bestLastRun)) {
                best = portal;
                bestLastRun = last;
            }
        }
        return best;
    }

    boolean portalOwesWork(UUID userId, String portal, Instant dayStart) {
        long appliedToday = events.countAppliedSince(userId, portal, dayStart);
        if (appliedToday < applyCapFor(portal)) return true;
        // Quota met. LinkedIn may still run for outreach, up to a daily ceiling so it cannot
        // loop all day once there is nothing left to apply to.
        return "linkedin".equalsIgnoreCase(portal)
                && runs.countByUserIdAndPortalAndCreatedAtGreaterThanEqual(userId, portal, dayStart)
                   < intSetting(limits().get("outreachBlocksPerDay"), 3);
    }

    /**
     * How long a live run may go untouched by its worker before we declare it abandoned.
     * The worker polls {@code /next} every ~4s, so anything approaching this means it is gone.
     */
    private static final long STALE_RUN_MINUTES = 10;

    /**
     * When this backend process started. The heartbeat map is in-memory, so a restart makes
     * every worker look absent — this is what stops the reaper acting on that illusion.
     */
    private static final Instant STARTED_AT = Instant.now();

    /**
     * End runs whose worker has vanished.
     *
     * Only the worker moves a run forward, so a live run with no worker behind it is finished
     * whether the database says so or not. Left alone it blocks {@link #tickRotationForUser}
     * permanently — the single most damaging failure in the whole rotation, because it is
     * silent: the dashboard shows "running" and nothing ever happens again.
     *
     * Deliberately conservative: it only acts when the worker has been unseen for
     * {@link #STALE_RUN_MINUTES} AND the run is older than that, so a backend restart (which
     * clears the in-memory heartbeat) cannot reap a run that is genuinely in progress — the
     * worker re-registers within seconds.
     */
    @Transactional
    public int reapStaleRuns(UUID userId) {
        if (isWorkerOnline(userId)) return 0;
        Instant seen = lastWorkerSeen.get(userId);
        Instant cutoff = Instant.now().minusSeconds(STALE_RUN_MINUTES * 60);

        // NEVER reap on the word of a heartbeat map we only just built.
        //
        // lastWorkerSeen is in-memory, so every backend deploy empties it. The previous version
        // treated "no heartbeat recorded" as "the worker is gone" and marked a perfectly healthy
        // live run as failed. /next then returned idle, the worker's poller saw its run vanish,
        // set state.stopped, and every loop in the portal adapter broke on its first check — a
        // block that printed its header, then its summary, with nothing in between. Both portals,
        // every time the backend restarted mid-run.
        //
        // If we have never heard from this worker, wait until the process has been up long
        // enough that a live worker would certainly have checked in (it polls every ~4s).
        if (seen == null) {
            if (STARTED_AT.isAfter(cutoff)) return 0;      // backend too young to judge
        } else if (seen.isAfter(cutoff)) {
            return 0;                                       // heard from it recently
        }

        int reaped = 0;
        for (String status : LIVE) {
            Optional<AgentRun> found = runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(userId, status);
            if (found.isEmpty()) continue;
            AgentRun r = found.get();
            Instant started = r.getStartedAt() != null ? r.getStartedAt() : r.getCreatedAt();
            if (started == null || started.isAfter(cutoff)) continue;   // too recent to judge
            r.setStatus("failed");
            r.setEndedAt(Instant.now());
            r.setCurrentAction("Ended — JobPilot Desktop stopped while this run was active");
            runs.save(r);
            reaped++;
            log.info("Reaped abandoned {} run {} for user {}", r.getPortal(), r.getId(), userId);
            try {
                recordEvent(userId, r.getId(), null, r.getPortal(), "info", null, null, null,
                        "Run ended automatically — the desktop app stopped while it was running.");
            } catch (Exception e) {
                log.debug("reap event failed: {}", e.getMessage());
            }
        }
        return reaped;
    }

    /** When the most recent run for this user ended (either portal), or null if none has. */
    Instant lastFinishedAt(UUID userId) {
        return runs.findByUserIdOrderByCreatedAtDesc(userId, PageRequest.of(0, 5)).stream()
                .map(AgentRun::getEndedAt)
                .filter(Objects::nonNull)
                .max(Instant::compareTo)
                .orElse(null);
    }

    private static int intSetting(Object v, int fallback) {
        if (v instanceof Number n) return n.intValue();
        if (v instanceof Boolean b) return b ? 1 : 0;   // flow switches read as 1/0
        return fallback;
    }

    /**
     * When this portal would next start.
     *
     * The trigger is quota + rest, not a clock-time block, so this answers the same question the
     * rotation actually asks: is work owed now (→ due immediately), are we resting (→ when rest
     * ends), or is the day done (→ tomorrow's reset at midnight IST)? Null only when the desktop
     * app isn't running, because then nothing is coming at all.
     */
    Instant nextWindowStart(UUID userId, String portal, Instant now) {
        if (isPaused() || !isWorkerOnline(userId)) return null;
        Instant dayStart = startOfTodayUtc();
        if (!portalOwesWork(userId, portal, dayStart)) {
            // Quota met — the next opportunity is when the daily counters reset.
            return java.time.LocalDate.now(ZONE).plusDays(1).atStartOfDay(ZONE).toInstant();
        }
        // Only ONE portal starts next, and the rest window is global (one run at a time). This
        // used to compute the same clock time for BOTH portals, so LinkedIn and Indeed showed an
        // identical "next run" when only one of them was actually going to start. A portal that
        // isn't first has no honest time to give — how long it waits depends on how long the
        // other one's block runs — so it returns null and the card says "after <portal>".
        if (!portal.equalsIgnoreCase(nextPortalWithWork(userId))) return null;

        int restMins = intSetting(limits().get("restMins"), 30);
        Instant lastEnd = lastFinishedAt(userId);
        Instant restUntil = lastEnd == null ? null : lastEnd.plusSeconds(restMins * 60L);
        if (restUntil != null && restUntil.isAfter(now)) return restUntil;
        return now;   // owed work, first in line, not resting: the next tick starts it
    }

    /**
     * Scheduler entry point — advance the rotation for every user whose desktop app is running.
     *
     * Previously this only considered users who had an {@code AgentSchedule} row, which meant a
     * user with no schedule was never even looked at. The trigger is the app being open, so the
     * heartbeat is the right list to walk; schedule rows are still included for anyone who has
     * them, so nobody is dropped.
     */
    @Transactional
    public void tickRotation() {
        if (isPaused()) return;
        java.util.Set<UUID> users = new java.util.LinkedHashSet<>(lastWorkerSeen.keySet());
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
        return connectionNote(userId, contactId, null);
    }

    /**
     * A follow-up message for a contact who already accepted, shaped by which touch this is.
     *
     * @param angle what THIS touch is for (from {@link FollowUpService#angleFor}). Without it
     *              every follow-up reads like the first one, which is how a sequence turns into
     *              nagging instead of a conversation.
     */
    public String followUpNote(UUID userId, UUID contactId, String angle) {
        PortalContact c = contactId == null ? null : contacts.findById(contactId).orElse(null);
        Profile p = profiles.get();
        String first = firstNameOf(c);
        String base = "Hi " + first + ", following up on my note"
                + (c != null && c.getCompany() != null && !c.getCompany().isBlank()
                   ? " about opportunities at " + c.getCompany() : "") + ".";
        if (!ai.isEnabled()) return cleanOutbound(base);

        String sys = """
                Write ONE short LinkedIn follow-up message, first person, warm and concrete.
                Under 400 characters. No clichés ("just checking in", "circling back"), no
                pressure, no invented facts — use only the candidate details given.
                Do not restate things an earlier message already covered.
                THIS MESSAGE'S PURPOSE: %s
                Output ONLY the message text.""".formatted(
                        angle == null || angle.isBlank() ? "a brief, useful nudge" : angle);
        String user = "CANDIDATE: " + nz(p.getFullName()) + " — " + nz(p.getCurrentTitle())
                + (p.getSkills() == null || p.getSkills().isEmpty() ? ""
                    : "\nSKILLS: " + String.join(", ", p.getSkills().stream().limit(10).toList()))
                + (p.getProjects() == null || p.getProjects().isEmpty() ? ""
                    : "\nPROJECTS: " + p.getProjects().stream().limit(3).map(String::valueOf)
                        .reduce((a, b) -> a + " | " + b).orElse(""))
                + "\nCONTACT: " + (c == null ? "a recruiter" : nz(c.getName()) + " at " + nz(c.getCompany()))
                + "\nDRAFT: " + base;
        String out = nz(ai.complete(sys, user, true, false)).trim();
        if (out.isBlank() || out.length() > 600) out = base;
        out = cleanOutbound(out);
        return out.length() > 600 ? out.substring(0, 597) + "…" : out;
    }

    /**
     * @param topic what this person recently posted about, when we verified them that way.
     *              Naming it is the difference between a note that could have been sent to
     *              anyone and one that proves we read their post.
     */
    public String connectionNote(UUID userId, UUID contactId, String topic) {
        PortalContact c = contactId == null ? null : contacts.findById(contactId).orElse(null);
        Profile p = profiles.get();
        String template = messageTemplate();
        String first = firstNameOf(c);
        String base = !template.isBlank() ? renderTemplate(template, c, p)
                : "Hi " + first + ", I'm " + nz(p.getFullName()) + ", a " + nz(p.getCurrentTitle())
                  + ". I'd love to connect regarding relevant openings"
                  + (c != null && c.getCompany() != null && !c.getCompany().isBlank() ? " at " + c.getCompany() : "") + ".";
        // YOUR TEMPLATE IS THE MESSAGE. The AI is only asked to adapt it when there is something
        // real to adapt it TO — a post the person actually wrote. Previously it rewrote every
        // note unconditionally, so a template you had chosen your words for was paraphrased away
        // on every send, and no two recruiters got the wording you actually approved.
        boolean hasTopic = topic != null && !topic.isBlank();
        boolean adapt = ai.isEnabled() && (hasTopic || template.isBlank());
        if (adapt) {
            String sys = """
                    Adapt this LinkedIn connection note. Keep the author's voice, structure and any
                    real name/role/company — you are personalising THEIR note, not writing your own.
                    Warm, first person, UNDER 280 characters, no clichés, no fabricated facts.
                    If a POST TOPIC is given, open by referring to it specifically — that is the whole
                    reason this person is being contacted — then keep the rest of the draft's substance.
                    Never invent a post that isn't given. Output ONLY the note text.""";
            String user = "CANDIDATE: " + nz(p.getFullName()) + " — " + nz(p.getCurrentTitle())
                    + (p.getSkills() == null || p.getSkills().isEmpty() ? ""
                        : "\nCANDIDATE SKILLS: " + String.join(", ", p.getSkills().stream().limit(10).toList()))
                    + "\nCONTACT: " + (c == null ? "a recruiter" : nz(c.getName()) + " at " + nz(c.getCompany()))
                    + (topic == null || topic.isBlank() ? "" : "\nPOST TOPIC: " + topic)
                    + "\nDRAFT: " + base;
            String opt = nz(ai.complete(sys, user, true, false)).trim();
            if (!opt.isBlank() && opt.length() <= 300) base = opt;
        }
        // Scrub again: the model can echo a placeholder from the draft it was given.
        base = cleanOutbound(base);
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
        String firstName = firstNameOf(c);
        return cleanOutbound(template
                .replace("[Name]", firstName)
                .replace("[Role]", c == null ? "your team's roles" : nz(c.getRole(), "your team's roles"))
                .replace("[Company]", c == null ? "your company" : nz(c.getCompany(), "your company"))
                .replace("[MyName]", nz(p.getFullName(), ""))
                .replace("[MyRole]", nz(p.getCurrentTitle(), nz(p.getHeadline(), ""))));
    }

    /**
     * A usable first name for a greeting, or "there".
     * recordHrLead stores the EMAIL as the name when a post gave no name, so "hr@acme.com" must
     * not become "Hi hr@acme.com," — anything that looks like an address falls back to "there".
     */
    private static String firstNameOf(PortalContact c) {
        String n = c == null ? null : c.getName();
        if (n == null || n.isBlank() || n.contains("@") || n.matches(".*\\d{3,}.*")) return "there";
        String first = n.trim().split("\\s+")[0];
        return first.length() < 2 ? "there" : first;
    }

    /**
     * Last line of defence before anything is SENT: no message may go out containing an
     * unfilled placeholder. A template with a token we don't know ("Hi [hiring manager name],",
     * "{{FirstName}}") used to be delivered verbatim — the reader sees the scaffolding and the
     * message is worse than useless. Name-ish placeholders become "there"; every other leftover
     * is removed, and the surrounding punctuation/whitespace is tidied so the sentence still reads.
     */
    static String cleanOutbound(String text) {
        if (text == null || text.isBlank()) return text;
        String s = text
                // greeting placeholders → a neutral, human greeting
                .replaceAll("(?i)[\\[{]{1,2}\\s*(hiring\\s*manager|recruiter|first\\s*name|firstname|name|contact)\\s*(name)?\\s*[\\]}]{1,2}", "there")
                // any other leftover token → drop it
                .replaceAll("[\\[{]{1,2}[^\\]}\\n]{0,40}[\\]}]{1,2}", "");
        // Tidy the damage so the sentence still reads.
        s = s.replaceAll("(?im)^(hi|hello|hey|dear)\\s*([,!.])", "$1 there$2")
             // "Dear there," is not English — a nameless greeting becomes "Hello there,".
             .replaceAll("(?i)\\bdear there\\b", "Hello there")
             .replaceAll("[ \\t]{2,}", " ");
        // Removing a token can strand its preposition ("connect about at."). Drop dangling
        // prepositions before punctuation, twice, so chains like "about at." fully collapse.
        for (int i = 0; i < 2; i++) {
            s = s.replaceAll("(?i)\\s*\\b(about|at|for|with|in|on|to|of|from|regarding)\\b\\s*(?=[.,!?])", "");
        }
        s = s.replaceAll("\\s+([,.!?])", "$1")
             .replaceAll("\\n{3,}", "\n\n");
        return s.trim();
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
