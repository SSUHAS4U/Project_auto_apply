package com.jobpilot.agent;

import com.jobpilot.domain.Profile;
import com.jobpilot.security.UserContext;
import com.jobpilot.service.ProfileService;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/**
 * The protocol the LOCAL Playwright worker speaks. Authenticated by X-Worker-Token
 * (AuthFilter maps it to the owning user and restricts it to /api/worker/**). The worker
 * polls {@code /next} for a work order, streams live frames + events as it drives the
 * real portal, and asks the brain to evaluate fit and answer screening questions.
 *
 * The browser runs on the owner's PC with their real logged-in sessions — safest for the
 * accounts, and free. This backend never sees a portal password.
 */
@RestController
@RequestMapping("/api/worker")
public class WorkerController {

    private static final Logger log = LoggerFactory.getLogger(WorkerController.class);

    private final AgentService agent;
    private final ProfileService profiles;
    private final AiService ai;

    public WorkerController(AgentService agent, ProfileService profiles, AiService ai) {
        this.agent = agent;
        this.profiles = profiles;
        this.ai = ai;
    }

    /** Handshake so the worker can confirm its token + show whose account it drives. */
    @GetMapping("/hello")
    public Map<String, Object> hello() {
        UUID u = UserContext.require();
        Profile p = profiles.get();
        return Map.of("ok", true, "userId", u.toString(),
                "name", nz(p.getFullName()), "paused", agent.isPaused());
    }

    /**
     * The work order. Returns the current live run + its search plan, or an idle/paused
     * signal. The worker calls this on a loop; between blocks it just gets {idle:true}.
     */
    @GetMapping("/next")
    public Map<String, Object> next() {
        UUID u = UserContext.require();
        if (agent.isPaused()) return Map.of("paused", true);
        AgentRun run = agent.activeRun(u);
        if (run == null) return Map.of("idle", true);
        // promote queued → running the moment a worker picks it up
        if ("queued".equals(run.getStatus())) run = agent.setRunStatus(u, run.getId(), "running", "Worker attached");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("runId", run.getId().toString());
        out.put("portal", run.getPortal());
        out.put("status", run.getStatus());
        out.put("plan", agent.searchPlan(u, run.getPortal()));
        return out;
    }

    /** Record something that happened (also bumps the run's metric counters). */
    @PostMapping("/event")
    public Map<String, Object> event(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        AgentEvent e = agent.recordEvent(u, uuid(b.get("runId")), uuid(b.get("taskId")),
                b.get("portal"), b.getOrDefault("type", "info"),
                b.get("title"), b.get("company"), b.get("url"), b.get("detail"));
        return Map.of("id", e.getId().toString());
    }

    /** Upload the latest live screenshot (downscaled JPEG, base64) for Watch Live. */
    @PostMapping("/frame")
    public Map<String, Object> frame(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        agent.putFrame(u, uuid(b.get("runId")), b.get("portal"), b.get("action"), b.get("imageB64"));
        return Map.of("ok", true, "paused", agent.isPaused());
    }

    /** Worker reports whether it has a logged-in session for a portal. */
    @PostMapping("/session")
    public Map<String, Object> session(@RequestBody Map<String, Object> b) {
        UUID u = UserContext.require();
        boolean loggedIn = b.get("loggedIn") != null && Boolean.parseBoolean(b.get("loggedIn").toString());
        agent.reportSession(u, str(b.get("portal")), loggedIn, str(b.get("detail")));
        return Map.of("ok", true);
    }

    /** Worker pulls pending connect/disconnect actions (cleared once delivered). */
    @GetMapping("/connection-actions")
    public List<Map<String, String>> connectionActions() {
        return agent.pullConnectionActions(UserContext.require());
    }

    /** Update run status / the human-readable "what it's doing now" caption. */
    @PostMapping("/run/{id}/status")
    public Map<String, Object> runStatus(@PathVariable UUID id, @RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        AgentRun r = agent.setRunStatus(u, id, b.get("status"), b.get("currentAction"));
        return Map.of("id", r.getId().toString(), "status", r.getStatus());
    }

    /** Quick keyword fit for a portal listing (reuses the ingest scorer). */
    @PostMapping("/evaluate")
    public Map<String, Object> evaluate(@RequestBody Map<String, String> b) {
        UserContext.require();
        int score = agent.evaluate(b.get("title"), b.get("company"), b.get("location"), b.get("description"));
        return Map.of("score", score);
    }

    /** The flattened profile answers the worker fills portal forms with. */
    @GetMapping("/profile")
    public Map<String, Object> profile() {
        UserContext.require();
        Profile p = profiles.get();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("full_name", nz(p.getFullName()));
        m.put("first_name", nz(p.getFirstName()));
        m.put("last_name", nz(p.getLastName()));
        m.put("email", nz(p.getEmail()));
        m.put("phone", nz(p.getPhone()));
        m.put("location", nz(p.getLocation()));
        m.put("city", nz(p.getCity()));
        m.put("state", nz(p.getState()));
        m.put("country", nz(p.getCountry()));
        m.put("postal_code", nz(p.getPostalCode()));
        m.put("current_title", nz(p.getCurrentTitle()));
        m.put("current_company", nz(p.getCurrentCompany()));
        m.put("years_experience", nz(p.getYearsExperience()));
        m.put("current_ctc", nz(p.getCurrentCtc()));
        m.put("expected_ctc", nz(p.getExpectedCtc()));
        m.put("notice_period", nz(p.getNoticePeriod()));
        m.put("work_authorization", nz(p.getWorkAuthorization()));
        m.put("skills", p.getSkills() == null ? List.of() : p.getSkills());
        m.put("links", p.getLinks() == null ? Map.of() : p.getLinks());
        m.put("field_map", p.getFieldMap() == null ? Map.of() : p.getFieldMap());
        return m;
    }

    /** The resume bytes to upload into portal file inputs. */
    @GetMapping("/resume")
    public Map<String, Object> resume() {
        UserContext.require();
        Profile p = profiles.get();
        byte[] data = p.getResumeData();
        if (data == null || data.length == 0) return Map.of("hasResume", false);
        return Map.of("hasResume", true,
                "filename", p.getResumeFilename() == null ? "resume.pdf" : p.getResumeFilename(),
                "contentBase64", Base64.getEncoder().encodeToString(data));
    }

    /**
     * Answer a screening question, grounded in the profile. Never fabricates: if the
     * profile can't support an answer it says so, so the worker can flag for attention.
     */
    @PostMapping("/answer")
    public Map<String, Object> answer(@RequestBody Map<String, Object> b) {
        UserContext.require();
        String question = str(b.get("question"));
        if (question == null || question.isBlank()) return Map.of("answer", "");
        @SuppressWarnings("unchecked")
        List<String> options = b.get("options") instanceof List ? (List<String>) b.get("options") : null;
        if (!ai.isEnabled()) return Map.of("answer", "", "needsAttention", true, "reason", "AI off");

        Profile p = profiles.get();
        String profileFacts = "Name: " + nz(p.getFullName()) + "; Title: " + nz(p.getCurrentTitle())
                + "; Experience(yrs): " + nz(p.getYearsExperience()) + "; Notice: " + nz(p.getNoticePeriod())
                + "; Current CTC: " + nz(p.getCurrentCtc()) + "; Expected CTC: " + nz(p.getExpectedCtc())
                + "; Location: " + nz(p.getLocation()) + "; Work auth: " + nz(p.getWorkAuthorization())
                + "; Skills: " + (p.getSkills() == null ? "" : String.join(", ", p.getSkills()));
        String sys = """
                You answer job-application screening questions AS the candidate, using ONLY
                the provided profile facts. Be concise and literal (a form field value, not a
                paragraph). If options are given, return EXACTLY one of them. If the profile
                cannot support an honest answer, return the token NEEDS_ATTENTION. Never invent
                numbers, dates, or qualifications.""";
        String user = "PROFILE FACTS:\n" + profileFacts + "\n\nQUESTION: " + question
                + (options != null ? "\nOPTIONS: " + String.join(" | ", options) : "");
        String out = nz(ai.complete(sys, user, true, false)).trim();
        if (out.isBlank() || out.contains("NEEDS_ATTENTION"))
            return Map.of("answer", "", "needsAttention", true, "reason", "not supported by profile");
        return Map.of("answer", out);
    }

    /** Record a discovered recruiter/hiring-manager for the Network CRM. */
    @PostMapping("/contact")
    public Map<String, Object> contact(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        PortalContact c = agent.upsertContact(u, b.get("portal"), b.get("name"),
                b.get("profileUrl"), b.get("company"), b.get("role"), b.get("sourceJobUrl"));
        return Map.of("id", c.getId().toString(), "connectionStatus", c.getConnectionStatus());
    }

    /**
     * Draft-first messaging: the worker asks the brain to draft a message (connection note
     * or a reply to an incoming recruiter message). It is saved as pending_approval — the
     * worker must NOT send it until the owner approves it in the dashboard.
     */
    @PostMapping("/message/draft")
    public Map<String, Object> draftMessage(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        AgentMessage m = agent.draftMessage(u, uuid(b.get("contactId")), b.get("incoming"), b.get("kind"));
        return Map.of("id", m.getId().toString(), "status", m.getStatus(), "body", nz(m.getBody()));
    }

    /** Approved outgoing messages the worker may now actually send on the portal. */
    @GetMapping("/messages/approved")
    public List<Map<String, Object>> approvedMessages() {
        UUID u = UserContext.require();
        return agent.approvedOutgoing(u).stream().map(m -> {
            Map<String, Object> x = new LinkedHashMap<>();
            x.put("id", m.getId().toString());
            x.put("contactId", m.getContactId() == null ? null : m.getContactId().toString());
            x.put("body", nz(m.getBody()));
            return x;
        }).toList();
    }

    @PostMapping("/messages/{id}/sent")
    public Map<String, Object> markSent(@PathVariable UUID id) {
        UUID u = UserContext.require();
        agent.markMessageSent(u, id);
        return Map.of("ok", true);
    }

    // ---- helpers --------------------------------------------------------------

    private static UUID uuid(String s) {
        try { return s == null || s.isBlank() ? null : UUID.fromString(s); } catch (Exception e) { return null; }
    }
    private static String str(Object o) { return o == null ? null : o.toString(); }
    private static String nz(String s) { return s == null ? "" : s; }
}
