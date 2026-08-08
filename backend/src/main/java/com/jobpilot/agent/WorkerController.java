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
    private final com.jobpilot.service.AssistService assist;
    private final com.jobpilot.service.ComposeService compose;
    private final FitService fit;
    private final OutreachGuard guard;
    private final FollowUpService followUps;

    public WorkerController(AgentService agent, ProfileService profiles, AiService ai,
                            com.jobpilot.service.AssistService assist,
                            com.jobpilot.service.ComposeService compose,
                            FitService fit, OutreachGuard guard, FollowUpService followUps) {
        this.agent = agent;
        this.profiles = profiles;
        this.ai = ai;
        this.assist = assist;
        this.compose = compose;
        this.fit = fit;
        this.guard = guard;
        this.followUps = followUps;
    }

    /**
     * An HR/recruiter email the worker harvested from a hiring post. Stores the lead
     * (deduped by email) + rings the bell; when the Auto-email flow is ON, sends the
     * application through the SAME pipeline as Compose &amp; send: a cold email tailored
     * to the post (from the user's email template), the user's uploaded resume attached
     * AS-IS, and a cover letter PDF from their template. Owner's decision: no CV
     * tailoring here — the starred resume is what gets sent.
     */
    @PostMapping("/hr-lead")
    public Map<String, Object> hrLead(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        String email = nz(b.get("email")).trim();
        if (email.isBlank() || !email.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}")) return Map.of("ok", false);
        PortalContact lead = agent.recordHrLead(u, b.get("portal"), b.get("name"), email,
                b.get("url"), b.get("title"));
        if (lead == null) return Map.of("ok", true, "duplicate", true);

        boolean autoEmail = Boolean.TRUE.equals(agent.flows().get("autoEmail"));
        String postText = nz(b.get("postText"));
        boolean sent = false;
        if (autoEmail && postText.length() > 120 && ai.isEnabled()) {
            try {
                String role = nz(b.get("title"));
                Map<String, String> docs = compose.generate(role, "", postText);
                String subject = nz(docs.get("subject"));
                if (subject.isBlank()) subject = "Application — " + nz(profiles.get().getFullName());
                compose.send(email, subject, docs.get("coldEmail"), docs.get("coverLetter"), true);
                sent = true;
                agent.recordEvent(u, uuid(b.get("runId")), null, b.get("portal"), "email_sent",
                        "Auto-emailed: " + email, null, b.get("url"), role);
            } catch (Exception e) {
                log.warn("auto-email to lead {} failed: {}", email, e.getMessage());
                agent.recordEvent(u, uuid(b.get("runId")), null, b.get("portal"), "error",
                        "Auto-email to " + email + " failed", null, b.get("url"),
                        String.valueOf(e.getMessage()).substring(0, Math.min(180, String.valueOf(e.getMessage()).length())));
            }
        }
        return Map.of("ok", true, "applying", sent);
    }

    /**
     * A screening question the automation could not answer — stored as PENDING in the
     * answer bank so the owner fills it once (Profile → Autofill answers) and every later
     * application with the same question is answered automatically.
     */
    @PostMapping("/question")
    public Map<String, Object> pendingQuestion(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        String q = b.getOrDefault("question", "");
        if (q.isBlank()) return Map.of("ok", false);
        // `answer` is what the automation used (may be blank). Stored so the owner can review
        // and correct it in Profile → Autofill answers; never overwrites an answer they set.
        assist.recordPending(u, q, b.get("answer"), b.get("portal"));
        return Map.of("ok", true);
    }

    /** Handshake so the worker can confirm its token + show whose account it drives. */
    @GetMapping("/hello")
    public Map<String, Object> hello() {
        UUID u = UserContext.require();
        agent.markWorkerSeen(u);
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
        agent.markWorkerSeen(u); // heartbeat — the dashboard uses this to know the app is running
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
                b.get("title"), b.get("company"), b.get("url"), b.get("detail"),
                b.get("salary"), b.get("description"), b.get("flow"));
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

    /**
     * Worker pulls pending connect/disconnect actions. These are NOT cleared by reading them —
     * see ackConnectionAction. Delivery is not proof the action happened, and treating it as
     * proof is what made Connect a button that silently did nothing.
     */
    @GetMapping("/connection-actions")
    public List<Map<String, String>> connectionActions() {
        return agent.pullConnectionActions(UserContext.require());
    }

    /** Worker confirms it carried an action out (or reports why it could not). */
    @PostMapping("/connection-ack")
    public Map<String, Object> connectionAck(@RequestBody Map<String, Object> b) {
        boolean ok = b.get("ok") != null && Boolean.parseBoolean(b.get("ok").toString());
        agent.ackConnectionAction(UserContext.require(), str(b.get("portal")), ok, str(b.get("detail")));
        return Map.of("ok", true);
    }

    /** Update run status / the human-readable "what it's doing now" caption. */
    @PostMapping("/run/{id}/status")
    public Map<String, Object> runStatus(@PathVariable UUID id, @RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        AgentRun r = agent.setRunStatus(u, id, b.get("status"), b.get("currentAction"));
        return Map.of("id", r.getId().toString(), "status", r.getStatus());
    }

    /**
     * Should the worker apply to this listing? Résumé-aware, not keyword overlap: returns
     * score + techMatch + the reason, so a Python role never slips past a Java/MERN résumé on
     * a matching job title alone. Falls back to the keyword score if the AI is unavailable.
     */
    @PostMapping("/evaluate")
    public Map<String, Object> evaluate(@RequestBody Map<String, String> b) {
        UserContext.require();
        return fit.jobFit(b.get("title"), b.get("company"), b.get("location"), b.get("description"));
    }

    /**
     * Should the worker contact this person at all? Headline decides outright where it can;
     * their recent posts are read only for the ambiguous middle. No evidence ⇒ no contact.
     */
    @PostMapping("/verify-person")
    public Map<String, Object> verifyPerson(@RequestBody Map<String, Object> b) {
        UserContext.require();
        Object posts = b.get("posts");
        List<String> recent = posts instanceof List<?> l
                ? l.stream().map(String::valueOf).filter(s -> !s.isBlank()).toList() : List.of();
        return fit.recruiterFit(str(b.get("name")), str(b.get("headline")), recent);
    }

    /**
     * Contacts whose next follow-up is due (Day 1 → 2 → 5 → 10, counted from the last touch).
     * Each carries the angle for THIS touch, so message 3 doesn't repeat message 1.
     */
    @GetMapping("/follow-ups")
    public List<Map<String, Object>> followUps(@RequestParam(defaultValue = "15") int limit) {
        UUID u = UserContext.require();
        return followUps.due(u, java.time.Instant.now(), Math.min(limit, 50)).stream().map(c -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("contactId", c.getId().toString());
            m.put("name", nz(c.getName()));
            m.put("profileUrl", nz(c.getProfileUrl()));
            m.put("company", nz(c.getCompany()));
            m.put("stage", c.getFollowUpStage());
            m.put("label", followUps.labelFor(c.getFollowUpStage()));
            m.put("body", agent.followUpNote(u, c.getId(), followUps.angleFor(c.getFollowUpStage())));
            return m;
        }).toList();
    }

    /** The worker reports a follow-up actually went out — advances the stage and the clock. */
    @PostMapping("/follow-up-sent")
    public Map<String, Object> followUpSent(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        PortalContact c = followUps.recordTouch(u, uuid(b.get("contactId")), java.time.Instant.now());
        if (c == null) return Map.of("ok", false);
        return Map.of("ok", true, "stage", c.getFollowUpStage(), "archived", c.getArchivedAt() != null);
    }

    /** Is this post a real opening? Replaces the email regex that found nothing in 150 posts. */
    @PostMapping("/post-intent")
    public Map<String, Object> postIntent(@RequestBody Map<String, String> b) {
        UserContext.require();
        return fit.postIntent(b.get("text"));
    }

    /**
     * May the worker contact this person — and record it in the same call. Enforces the
     * idempotency hash and the per-company / per-recruiter / per-day limits. Check-then-record
     * as ONE operation, so a retry can't slip a duplicate through between the two.
     */
    @PostMapping("/outreach-claim")
    public Map<String, Object> outreachClaim(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        return guard.claim(u, b.get("portal"), b.get("company"), b.get("role"),
                b.get("recruiterUrl"), b.get("recruiterName"), nz(b.get("resumeVersion")),
                b.get("email"), b.get("channel"));
    }

    /** The flattened profile answers the worker fills portal forms with. */
    @GetMapping("/profile")
    public Map<String, Object> profile() {
        UserContext.require();
        Profile p = profiles.get();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("full_name", nz(p.getFullName()));
        com.jobpilot.service.NameParts np0 = com.jobpilot.service.NameParts.of(p);
        m.put("first_name", np0.first());
        m.put("middle_name", np0.middle());
        m.put("last_name", np0.last());
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
        // More Easy-Apply autofill answers, straight from the profile.
        m.put("first_name_alt", np0.first());
        m.put("headline", nz(p.getHeadline()));
        m.put("address", nz(p.getAddress()));
        m.put("experience_level", nz(p.getExperienceLevel()));
        m.put("job_type", nz(p.getJobType()));
        m.put("available_from", nz(p.getAvailableFrom()));
        m.put("gender", nz(p.getGender()));
        m.put("nationality", nz(p.getNationality()));
        m.put("disability_status", nz(p.getDisabilityStatus()));
        m.put("requires_sponsorship", yesNo(p.getRequiresSponsorship()));
        m.put("willing_to_relocate", yesNo(p.getWillingToRelocate()));
        m.put("phone_country_code", nz(p.getPhoneCountryCode()));
        m.put("willing_remote", yesNo(p.getWillingRemote()));
        m.put("willing_onsite", yesNo(p.getWillingOnsite()));
        m.put("security_clearance", yesNo(p.getSecurityClearance()));
        m.put("highest_education", nz(p.getHighestEducation()));
        m.put("gpa", nz(p.getGpa()));
        m.put("completed_bachelors", yesNo(p.getCompletedBachelors()));
        m.put("ethnicity", nz(p.getEthnicity()));
        m.put("veteran_status", nz(p.getVeteranStatus()));
        m.put("hispanic_latino", yesNo(p.getHispanicLatino()));
        m.put("how_did_you_hear", nz(p.getHowDidYouHear()));
        m.put("skills_experience", p.getSkillsExperience() == null ? Map.of() : p.getSkillsExperience());
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

        // Route through the SAME engine the extension uses, instead of a separate fast-model
        // prompt with a thin profile. That old path is what answered "how many years of Go?"
        // with a PIN code (520010): fast model, no shape enforcement, no verification.
        // AssistService.choose() constrains the answer to a real option; answer() decides the
        // shape (a "how many years" question becomes a bare number, and an out-of-range or
        // non-numeric result is dropped) and reads the full profile with the strong model.
        try {
            if (options != null && !options.isEmpty()) {
                Map<String, Object> r = assist.choose(question, options, false);
                @SuppressWarnings("unchecked")
                List<String> sel = r.get("selected") instanceof List ? (List<String>) r.get("selected") : List.of();
                if (sel.isEmpty()) return Map.of("answer", "", "needsAttention", true, "reason", "no option fit the profile");
                return Map.of("answer", sel.get(0));
            }
            Map<String, Object> r = assist.answer(question);
            String out = nz((String) r.get("answer")).trim();
            if (out.isBlank())
                return Map.of("answer", "", "needsAttention", true, "reason", "not supported by profile");
            // Tell the worker whether this came from the bank, so it does not re-record an
            // answer it just read from there. Without it every reuse rewrites the same row and
            // the "first asked on" attribution drifts.
            String src = nz((String) r.get("source"));
            return Map.of("answer", out, "fromSaved", src.startsWith("saved") || src.startsWith("auto-reused"));
        } catch (Exception e) {
            return Map.of("answer", "", "needsAttention", true, "reason", "answer failed");
        }
    }

    /** Record a discovered recruiter/hiring-manager for the Network CRM. */
    @PostMapping("/contact")
    public Map<String, Object> contact(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        PortalContact c = agent.upsertContact(u, b.get("portal"), b.get("name"),
                b.get("profileUrl"), b.get("company"), b.get("role"), b.get("sourceJobUrl"));
        return Map.of("id", c.getId().toString(), "connectionStatus", c.getConnectionStatus());
    }

    /** Contacts we've invited and are waiting on — the worker checks these for acceptance. */
    @GetMapping("/contacts/pending")
    public List<Map<String, Object>> pendingConnections() {
        UUID u = UserContext.require();
        return agent.pendingConnections(u).stream().map(c -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.getId().toString());
            m.put("name", nz(c.getName()));
            m.put("profileUrl", nz(c.getProfileUrl()));
            m.put("company", nz(c.getCompany()));
            m.put("role", nz(c.getRole()));
            return m;
        }).toList();
    }

    /** Advance a contact's invite lifecycle (connection_sent → pending, or connected). */
    @PostMapping("/contact/{id}/connection-status")
    public Map<String, Object> connectionStatus(@PathVariable UUID id, @RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        PortalContact c = agent.setConnectionStatus(u, id, b.getOrDefault("status", "pending"));
        if ("pending".equals(c.getConnectionStatus()))
            agent.recordEvent(u, uuid(b.get("runId")), null, c.getPortal(), "connection_sent",
                    "Invite sent: " + nz(c.getName()), c.getCompany(), c.getProfileUrl(), b.get("note"));
        return Map.of("id", c.getId().toString(), "connectionStatus", c.getConnectionStatus());
    }

    /** The short, AI-optimized note to attach to a connection request for this contact. */
    @PostMapping("/connection-note")
    public Map<String, Object> connectionNote(@RequestBody Map<String, String> b) {
        UUID u = UserContext.require();
        return Map.of("note", agent.connectionNote(u, uuid(b.get("contactId")), b.get("topic")));
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
            // include the target so the worker can open the right thread + attach the résumé
            PortalContact c = agent.contactById(u, m.getContactId());
            x.put("profileUrl", c == null ? "" : nz(c.getProfileUrl()));
            x.put("name", c == null ? "" : nz(c.getName()));
            x.put("portal", c == null ? nz(m.getPortal()) : nz(c.getPortal()));
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
    private static String yesNo(Boolean b) { return b == null ? "" : (b ? "Yes" : "No"); }
}
