package com.jobpilot.web;

import com.jobpilot.agent.AgentEventRepository;
import com.jobpilot.agent.AgentRun;
import com.jobpilot.agent.AgentRunRepository;
import com.jobpilot.agent.AgentService;
import com.jobpilot.domain.AppUser;
import com.jobpilot.repository.AppUserRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.*;

/**
 * Read-only run diagnostics, reachable with the machine token.
 *
 * Why this exists: every automation problem in this project has been debugged by the owner
 * copying a terminal log into a chat window, which means the loop is
 *   run → notice → copy → paste → guess which build that was → fix.
 * Half of that is transcription. The worker already reports everything it does to the backend,
 * so the same facts can simply be read back: what the last runs were, how they ENDED, and the
 * errors they emitted. "Why did the run stop after twenty jobs?" is answerable from here
 * without anyone pasting anything.
 *
 * Deliberately read-only and under /api/ingest-diag so the existing machine-token rule covers
 * it: it can report, and it can change nothing.
 */
@RestController
public class DiagnosticsController {

    private final AgentRunRepository runs;
    private final AgentEventRepository events;
    private final AgentService agent;
    private final AppUserRepository users;

    public DiagnosticsController(AgentRunRepository runs, AgentEventRepository events,
                                 AgentService agent, AppUserRepository users) {
        this.runs = runs;
        this.events = events;
        this.agent = agent;
        this.users = users;
    }

    /** The owner — this is a single-operator deployment, so the first account is the subject. */
    private UUID ownerId() {
        // Resolve from the DATA, not from account ordering. The first version picked the
        // lowest UUID, which is arbitrary — it reported "runs: 0" on a deployment with a long
        // run history, because it was answering about the wrong account. Whoever owns the most
        // recent run is the operator; fall back to any account so a fresh install still answers.
        List<AgentRun> latest = runs.findAll(
                PageRequest.of(0, 1, org.springframework.data.domain.Sort.by(
                        org.springframework.data.domain.Sort.Direction.DESC, "createdAt"))).getContent();
        if (!latest.isEmpty() && latest.get(0).getUserId() != null) return latest.get(0).getUserId();
        return users.findAll().stream()
                .map(AppUser::getId).filter(Objects::nonNull)
                .min(Comparator.comparing(UUID::toString)).orElse(null);
    }

    /**
     * @param limit how many recent runs to describe
     * @param errors how many recent error/info events to include for the newest run
     */
    @GetMapping("/api/ingest-diag/runs")
    public Map<String, Object> runDiagnostics(@RequestParam(defaultValue = "6") int limit,
                                              @RequestParam(defaultValue = "40") int errors) {
        Map<String, Object> out = new LinkedHashMap<>();
        UUID uid = ownerId();
        if (uid == null) { out.put("error", "no user account yet"); return out; }

        out.put("now", Instant.now().toString());
        out.put("workerOnline", agent.isWorkerOnline(uid));
        out.put("paused", agent.isPaused());

        List<Map<String, Object>> runList = new ArrayList<>();
        // Newest first, across every status — the point is to see how runs ENDED, so a filter
        // on "running" would hide exactly the ones worth looking at.
        for (AgentRun r : runs.findByUserIdOrderByCreatedAtDesc(uid,
                PageRequest.of(0, Math.max(1, Math.min(limit, 25))))) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.getId().toString());
            m.put("portal", r.getPortal());
            m.put("status", r.getStatus());
            m.put("createdAt", String.valueOf(r.getCreatedAt()));
            m.put("startedAt", String.valueOf(r.getStartedAt()));
            m.put("endedAt", String.valueOf(r.getEndedAt()));
            // The last thing the worker said it was doing — usually names the step that stalled.
            m.put("currentAction", r.getCurrentAction());
            if (r.getStartedAt() != null) {
                Instant end = r.getEndedAt() != null ? r.getEndedAt() : Instant.now();
                m.put("ranForMinutes", java.time.Duration.between(r.getStartedAt(), end).toMinutes());
            }
            runList.add(m);
        }
        out.put("runs", runList);

        // Errors from the most recent run: what actually went wrong, in the worker's own words.
        if (!runList.isEmpty()) {
            List<Map<String, Object>> errs = new ArrayList<>();
            // There is no by-run finder, so take a recent slice for the user and keep the ones
            // belonging to this run. Cheap at these sizes and avoids adding a query for a
            // read-only diagnostic.
            events.findByUserIdOrderByCreatedAtDesc(uid,
                    PageRequest.of(0, Math.max(50, Math.min(errors * 8, 600)))).forEach((e) -> {
                if (errs.size() >= Math.max(1, Math.min(errors, 300))) return;
                // NOT filtered to the newest run, and NOT filtered to error/info.
                //
                // Both filters hid the only thing worth seeing. The OUTCOME of a job that
                // passed the gate is a manual_apply / easy_apply event, so excluding those
                // types meant the endpoint could report "19 relevant, 2 applied" and give no
                // way at all to see what became of the other 17 — which is exactly the
                // question being asked of it.
                if ("job_identified".equals(e.getType())) return;   // one per job, drowns the rest
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("at", String.valueOf(e.getCreatedAt()));
                m.put("type", e.getType());
                m.put("flow", e.getFlow());
                m.put("title", e.getTitle());
                m.put("detail", e.getDetail());
                m.put("runId", String.valueOf(e.getRunId()).substring(0, 8));
                errs.add(m);
            });
            out.put("latestRunEvents", errs);
        }

        // What the run produced, so "it ran but did nothing" is distinguishable from "it never ran".
        Map<String, Object> today = new LinkedHashMap<>();
        for (String type : List.of("easy_apply", "manual_apply", "relevant", "post_analysed",
                "email_sent", "message_sent", "error")) {
            today.put(type, events.countByUserIdAndTypeAndCreatedAtAfter(uid, type, startOfTodayUtc()));
        }
        out.put("todayByType", today);

        // The CONFIGURED budgets. Four LinkedIn runs came in at exactly 15 minutes each and I
        // read that as "it ran out of jobs" — an identical duration four times is a deadline,
        // not exhaustion. Guessing at settings from the outside is how that happened, so the
        // settings are reported here: easyApplyMins is what phase1Minutes is built from, and
        // the flow minutes are what the block length is built from.
        try {
            Map<String, Object> cfg = agent.limits();
            Map<String, Object> budget = new LinkedHashMap<>();
            for (String k : List.of("easyApplyOn", "easyApplyMins", "postApplyOn", "postApplyMins",
                    "emailOutreachOn", "emailOutreachMins", "connectionsOn", "connectionsMins",
                    "indeedMins", "restMins", "fitMin", "linkedinApplyCap", "indeedApplyCap",
                    "maxKeywords", "maxLocations", "pagesPerSearch", "maxAgeDays")) {
                if (cfg.containsKey(k)) budget.put(k, cfg.get(k));
            }
            out.put("settings", budget);
        } catch (Exception e) {
            out.put("settings", Map.of("error", String.valueOf(e.getMessage())));
        }
        return out;
    }

    private static Instant startOfTodayUtc() {
        return Instant.now().truncatedTo(java.time.temporal.ChronoUnit.DAYS);
    }
}
