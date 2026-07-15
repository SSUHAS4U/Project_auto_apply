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

    private static final List<String> PORTALS = List.of("linkedin", "naukri", "indeed");

    public AgentService(AgentRunRepository runs, AgentEventRepository events,
                        AgentScheduleRepository schedules, LiveFrameService frames,
                        SettingsService settings, ProfileService profiles, KeywordMatchScorer scorer,
                        PortalContactRepository contacts, AgentMessageRepository messages,
                        PortalConnectionRepository connections,
                        com.jobpilot.service.ai.AiService ai) {
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
        this.ai = ai;
    }

    // ---- portal connections (the "Connect" UX) ------------------------------

    /** All portal connections, seeding a disconnected row for any portal not yet seen. */
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
        return connections.findByUserIdOrderByPortalAsc(userId);
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
        // don't flip a "connecting" row to disconnected until the worker confirms either way
        c.setStatus(loggedIn ? "connected" : "disconnected");
        c.setDetail(detail);
        c.setUpdatedAt(Instant.now());
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
        if (status != null) r.setStatus(status);
        if (currentAction != null) r.setCurrentAction(currentAction);
        if ("done".equals(status) || "failed".equals(status)) r.setEndedAt(Instant.now());
        return runs.save(r);
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
        AgentEvent saved = events.save(e);
        if (runId != null) bumpRunCounter(runId, type);
        return saved;
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

    /** Search keywords + locations for a portal block: explicit override, else from profile. */
    public Map<String, Object> searchPlan(UUID userId, String portal) {
        Profile p = profiles.get();
        AgentSchedule block = schedules.findByUserIdOrderByOrdAsc(userId).stream()
                .filter(b -> b.getPortal().equalsIgnoreCase(portal)).findFirst().orElse(null);

        List<String> keywords = new ArrayList<>();
        if (block != null && block.getKeywords() != null && !block.getKeywords().isBlank()) {
            for (String k : block.getKeywords().split(",")) if (!k.isBlank()) keywords.add(k.trim());
        } else {
            if (p.getCurrentTitle() != null && !p.getCurrentTitle().isBlank()) keywords.add(p.getCurrentTitle().trim());
            if (p.getHeadline() != null && !p.getHeadline().isBlank()) keywords.add(p.getHeadline().trim());
            if (p.getSkills() != null) p.getSkills().stream().limit(5).forEach(keywords::add);
        }
        if (keywords.isEmpty()) keywords.add("software engineer");

        List<String> locations = new ArrayList<>();
        if (block != null && block.getLocations() != null && !block.getLocations().isBlank()) {
            for (String l : block.getLocations().split(",")) if (!l.isBlank()) locations.add(l.trim());
        } else {
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
        return plan;
    }

    // ---- Network CRM: contacts + draft-first messaging ----------------------

    public List<PortalContact> contacts(UUID userId, int limit) {
        return contacts.findByUserIdOrderByUpdatedAtDesc(userId, PageRequest.of(0, limit));
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

    /**
     * Draft-first: AI drafts a message (a connection note, or a reply to an incoming
     * recruiter message) grounded in the profile, saved as pending_approval. It is NOT
     * sent until the owner approves it in the dashboard.
     */
    @Transactional
    public AgentMessage draftMessage(UUID userId, UUID contactId, String incoming, String kind) {
        PortalContact c = contactId == null ? null : contacts.findById(contactId).orElse(null);
        if (incoming != null && !incoming.isBlank()) {
            // log the recruiter's inbound message and mark the contact as replied
            AgentMessage in = new AgentMessage();
            in.setUserId(userId);
            in.setContactId(contactId);
            in.setPortal(c == null ? null : c.getPortal());
            in.setDirection("in");
            in.setBody(incoming);
            in.setStatus("received");
            messages.save(in);
            if (c != null) { c.setConnectionStatus("replied"); c.setLastMessageAt(Instant.now()); contacts.save(c); }
        }

        Profile p = profiles.get();
        String draft;
        if (ai.isEnabled()) {
            String sys = """
                    You draft short, warm, professional messages a job seeker sends to a
                    recruiter/hiring contact. 40-70 words, first person, specific, no clichés,
                    no fabricated facts. If replying, address their message directly. Never
                    negotiate salary or commit to interview times — defer those politely to
                    the person. Output only the message text.""";
            String user = "CANDIDATE: " + nz(p.getFullName()) + " — " + nz(p.getCurrentTitle())
                    + "\nSKILLS: " + (p.getSkills() == null ? "" : String.join(", ", p.getSkills()))
                    + "\nCONTACT: " + (c == null ? "recruiter" : nz(c.getName()) + " at " + nz(c.getCompany()))
                    + "\nKIND: " + nz(kind)
                    + (incoming != null && !incoming.isBlank() ? "\nTHEIR MESSAGE: " + incoming
                       : "\nGOAL: a brief connection/intro note about fit for their roles.");
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
