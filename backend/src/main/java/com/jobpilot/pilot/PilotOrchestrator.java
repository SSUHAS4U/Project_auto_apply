package com.jobpilot.pilot;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.Application;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.repository.ApplicationRepository;
import com.jobpilot.repository.JobRepository;
import com.jobpilot.security.UserContext;
import com.jobpilot.service.ApplicationService;
import com.jobpilot.service.IngestService;
import com.jobpilot.service.JobDescriptionService;
import com.jobpilot.service.MailAttachment;
import com.jobpilot.service.MailService;
import com.jobpilot.service.NotFoundException;
import com.jobpilot.service.NotificationService;
import com.jobpilot.service.ProfileService;
import com.jobpilot.service.SettingsService;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The Pilot engine — an automated, per-job replica of the ai-job-search workflow.
 * One daily cycle:
 *
 *   SCRAPE  connectors have already pulled the portals; new fresh postings enter
 *           the backlog (dedup by job AND by company+role, like seen_jobs.json +
 *           the tracker CSV).
 *   RANK    backlog ordered by quick match score; top maxPerCycle enter the
 *           pipeline (the framework's /rank shortlist).
 *   APPLY   per job: evaluate (6-dim weighted framework, verdict gate) → draft
 *           tailored CV + cover letter → independent reviewer critique → revise →
 *           compile PDF (repair loop) → ATS verify (text layer + keyword coverage)
 *           → submit (email jobs, fully automatic) or queue (portal jobs, for the
 *           extension) → tracked in Applications.
 *
 * Every stage transition and artifact is persisted — the dashboard is a pure
 * observer (its only controls: pause/resume, run-now). One toggle pauses it all.
 */
@Service
public class PilotOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(PilotOrchestrator.class);

    private static final String K_ENABLED = "pilot_enabled";
    private static final String K_CONFIG = "pilot_config";
    private static final int MAX_CONSECUTIVE_MAIL_FAILURES = 3;
    private static final int MAX_NEW_PER_SCAN = 500;

    private final PilotCycleRepository cycles;
    private final PilotJobRepository pilotJobs;
    private final JobRepository jobRepo;
    private final ApplicationRepository appRepo;
    private final ApplicationService applications;
    private final ProfileService profiles;
    private final JobDescriptionService descriptions;
    private final FitEvaluationService evaluator;
    private final DrafterService drafter;
    private final ReviewerService reviewer;
    private final CompileVerifyService compiler;
    private final MailService mail;
    private final NotificationService notifications;
    private final SettingsService settings;
    private final IngestService ingest;
    private final AiService ai;
    private final JobPilotProperties props;
    private final ObjectMapper mapper = new ObjectMapper();

    private final ExecutorService pool = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "jobpilot-pilot");
        t.setDaemon(true);
        return t;
    });
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicReference<String> lastOutcome = new AtomicReference<>("never run");
    /** Live progress line for the dashboard while a cycle runs. */
    private final AtomicReference<String> progress = new AtomicReference<>("");

    public PilotOrchestrator(PilotCycleRepository cycles, PilotJobRepository pilotJobs,
                             JobRepository jobRepo, ApplicationRepository appRepo,
                             ApplicationService applications, ProfileService profiles,
                             JobDescriptionService descriptions, FitEvaluationService evaluator,
                             DrafterService drafter, ReviewerService reviewer,
                             CompileVerifyService compiler, MailService mail,
                             NotificationService notifications, SettingsService settings,
                             IngestService ingest, AiService ai, JobPilotProperties props) {
        this.cycles = cycles;
        this.pilotJobs = pilotJobs;
        this.jobRepo = jobRepo;
        this.appRepo = appRepo;
        this.applications = applications;
        this.profiles = profiles;
        this.descriptions = descriptions;
        this.evaluator = evaluator;
        this.drafter = drafter;
        this.reviewer = reviewer;
        this.compiler = compiler;
        this.mail = mail;
        this.notifications = notifications;
        this.settings = settings;
        this.ingest = ingest;
        this.ai = ai;
        this.props = props;
    }

    // ---- configuration ---------------------------------------------------------

    public record Config(int maxPerCycle, int minFitScore, int emailDailyCap,
                         int lookbackDays, boolean reviewerEnabled, boolean tailorCv,
                         boolean ingestFirst) {
        public static Config defaults() {
            return new Config(25, 60, 150, 3, true, true, true);
        }
        Config sanitized() {
            return new Config(clamp(maxPerCycle, 1, 100), clamp(minFitScore, 0, 100),
                    clamp(emailDailyCap, 0, 500), clamp(lookbackDays, 1, 14),
                    reviewerEnabled, tailorCv, ingestFirst);
        }
        private static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }
    }

    public Config config() {
        return settings.get(K_CONFIG).map(json -> {
            try {
                return mapper.readValue(json, Config.class).sanitized();
            } catch (Exception e) {
                return Config.defaults();
            }
        }).orElse(Config.defaults());
    }

    public Config saveConfig(Config in) {
        Config c = in.sanitized();
        try {
            settings.put(K_CONFIG, mapper.writeValueAsString(c));
        } catch (Exception e) {
            throw new IllegalStateException("could not save config: " + e.getMessage());
        }
        return c;
    }

    public boolean isEnabled() {
        return settings.get(K_ENABLED).map(Boolean::parseBoolean).orElse(false);
    }

    public void setEnabled(boolean enabled) {
        settings.put(K_ENABLED, String.valueOf(enabled));
        log.info("Pilot {}", enabled ? "RESUMED" : "PAUSED");
    }

    // ---- status (the dashboard's window into the engine) -------------------------

    public Map<String, Object> status() {
        UUID userId = ownerUserId();
        Instant dayAgo = Instant.now().minus(1, ChronoUnit.DAYS);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", isEnabled());
        out.put("running", running.get());
        out.put("progress", progress.get());
        out.put("lastOutcome", lastOutcome.get());
        out.put("config", config());
        out.put("aiEnabled", ai.isEnabled());
        Map<String, Long> stages = new LinkedHashMap<>();
        for (Object[] row : pilotJobs.countByStage(userId)) {
            stages.put(String.valueOf(row[0]), (Long) row[1]);
        }
        out.put("stageCounts", stages);
        out.put("submittedToday", pilotJobs.countByUserIdAndStageAndUpdatedAtAfter(userId, "submitted", dayAgo));
        out.put("queuedToday", pilotJobs.countByUserIdAndStageAndUpdatedAtAfter(userId, "queued", dayAgo));
        out.put("queuePending", pilotJobs.countByUserIdAndQueueStatus(userId, "pending"));
        out.put("nextRunAt", nextRunAt());
        cycles.findFirstByUserIdAndStatusOrderByStartedAtDesc(userId, "completed")
                .ifPresent(c -> out.put("lastCycle", c));
        return out;
    }

    private String nextRunAt() {
        if (!isEnabled()) return null;
        String cron = props.getSchedule().getAutoApplyCron();
        if (cron == null || "-".equals(cron.trim())) return null;
        try {
            ZoneId zone = ZoneId.of(props.getSchedule().getZone());
            LocalDateTime next = CronExpression.parse(cron).next(LocalDateTime.now(zone));
            return next == null ? null : next.atZone(zone).toInstant().toString();
        } catch (Exception e) {
            return null;
        }
    }

    // ---- cycle execution -----------------------------------------------------------

    public Map<String, Object> startAsync(String trigger) {
        if (running.get()) {
            return Map.of("status", "busy", "message", "A cycle is already in progress.");
        }
        pool.submit(() -> {
            try {
                run(trigger);
            } catch (Exception e) {
                log.warn("Pilot cycle failed: {}", e.getMessage(), e);
            }
        });
        return Map.of("status", "started",
                "message", "Cycle started — watch the pipeline board; it updates live.");
    }

    public Map<String, Object> run(String trigger) {
        if (!isEnabled()) {
            log.info("Pilot is paused — skipping {} cycle", trigger);
            return Map.of("status", "paused", "message", "Pilot is paused. Resume it to run.");
        }
        if (!running.compareAndSet(false, true)) {
            return Map.of("status", "busy", "message", "A cycle is already in progress.");
        }
        UUID userId = ownerUserId();
        boolean hadContext = UserContext.get() != null;
        if (!hadContext) UserContext.set(userId);
        PilotCycle cycle = new PilotCycle();
        cycle.setUserId(userId);
        cycle.setTrigger(trigger);
        cycle = cycles.save(cycle);
        try {
            Map<String, Object> result = doCycle(cycle, userId);
            lastOutcome.set(cycle.getSummary());
            return result;
        } catch (Exception e) {
            cycle.setStatus("failed");
            cycle.setError(e.getMessage());
            cycle.setFinishedAt(Instant.now());
            cycles.save(cycle);
            lastOutcome.set("failed: " + e.getMessage());
            notifications.create("pilot", "Pilot cycle failed", String.valueOf(e.getMessage()), Map.of());
            throw e;
        } finally {
            if (!hadContext) UserContext.clear();
            running.set(false);
            progress.set("");
        }
    }

    private Map<String, Object> doCycle(PilotCycle cycle, UUID userId) {
        Config cfg = config();
        Profile owner = profiles.getOwner();

        if (!ai.isEnabled()) {
            cycle.setStatus("completed");
            cycle.setSummary("Pipeline requires an AI provider (evaluate/draft/review are AI stages) — "
                    + "configure Groq/Gemini/Ollama in Settings.");
            cycle.setFinishedAt(Instant.now());
            cycles.save(cycle);
            return Map.of("status", "completed", "summary", cycle.getSummary());
        }

        if (cfg.ingestFirst() && "scheduled".equals(cycle.getTrigger())) {
            progress.set("Refreshing job sources…");
            try {
                ingest.run();
            } catch (Exception e) {
                log.warn("Pilot pre-ingest failed ({}); continuing with existing jobs", e.getMessage());
            }
        }

        // SCRAPE: new fresh postings into the backlog (dedup: job id + company+role).
        progress.set("Scanning fresh postings…");
        List<Job> fresh = jobRepo.findPilotCandidates(userId,
                Instant.now().minus(cfg.lookbackDays(), ChronoUnit.DAYS), MAX_NEW_PER_SCAN);
        int added = 0;
        for (Job j : fresh) {
            if (pilotJobs.existsByCompanyAndTitle(userId, j.getCompany(), j.getTitle())) continue;
            PilotJob p = new PilotJob();
            p.setUserId(userId);
            p.setJobId(j.getId());
            p.setJobTitle(j.getTitle());
            p.setJobCompany(j.getCompany());
            p.setJobLocation(j.getLocation());
            p.setJobUrl(j.getUrl());
            p.setJobApplyType(j.getApplyType());
            p.setJobApplyEmail(j.getApplyEmail());
            p.setMatchScore(j.getMatchScore());
            logStage(p, "scraped", "found via " + j.getSource() + " · quick fit "
                    + quickFit(j.getMatchScore()));
            pilotJobs.save(p);
            added++;
        }
        cycle.setScanned(fresh.size());

        // RANK: best of the whole backlog (this scan + earlier not-yet-picked jobs).
        List<PilotJob> picked = pilotJobs.findByUserIdAndStageOrderByMatchScoreDesc(
                userId, "scraped", PageRequest.of(0, cfg.maxPerCycle()));
        cycle.setPicked(picked.size());
        cycles.save(cycle);

        Instant dayAgo = Instant.now().minus(1, ChronoUnit.DAYS);
        long emailBudget = cfg.emailDailyCap()
                - appRepo.countByUserIdAndMethodAndAppliedAtAfter(userId, "email", dayAgo);
        int evaluated = 0, submitted = 0, queued = 0, skipped = 0, failed = 0;
        int consecutiveMailFailures = 0;
        boolean mailOpen = !isBlank(props.getMail().getFrom());

        int i = 0;
        for (PilotJob p : picked) {
            i++;
            progress.set("Job " + i + "/" + picked.size() + ": " + p.getJobTitle()
                    + " @ " + safe(p.getJobCompany()));
            p.setCycleId(cycle.getId());
            try {
                String outcome = pipeline(p, owner, cfg,
                        mailOpen && emailBudget - submitted > 0 && consecutiveMailFailures < MAX_CONSECUTIVE_MAIL_FAILURES);
                switch (outcome) {
                    case "submitted" -> { submitted++; evaluated++; consecutiveMailFailures = 0; }
                    case "queued" -> { queued++; evaluated++; }
                    case "skipped" -> { skipped++; evaluated++; }
                    case "mail_failed" -> { failed++; evaluated++; consecutiveMailFailures++; }
                    default -> evaluated++;
                }
            } catch (Exception e) {
                log.warn("Pipeline failed for '{}': {}", p.getJobTitle(), e.getMessage());
                p.setStage("failed");
                p.setError(e.getMessage());
                logStage(p, "failed", e.getMessage());
                failed++;
            }
            p.setUpdatedAt(Instant.now());
            pilotJobs.save(p);
        }

        cycle.setEvaluated(evaluated);
        cycle.setSubmitted(submitted);
        cycle.setQueued(queued);
        cycle.setSkipped(skipped);
        cycle.setFailed(failed);
        cycle.setStatus("completed");
        cycle.setFinishedAt(Instant.now());
        StringBuilder summary = new StringBuilder()
                .append(added).append(" new postings scanned in, ")
                .append(picked.size()).append(" entered the pipeline: ")
                .append(submitted).append(" submitted, ").append(queued).append(" queued, ")
                .append(skipped).append(" below the fit bar, ").append(failed).append(" failed");
        if (consecutiveMailFailures >= MAX_CONSECUTIVE_MAIL_FAILURES) {
            summary.append(" · email sends backed off after repeated mailbox failures");
        }
        cycle.setSummary(summary.toString());
        cycles.save(cycle);

        notifications.create("pilot",
                "Pilot: " + submitted + " submitted, " + queued + " queued",
                cycle.getSummary(), Map.of("cycleId", String.valueOf(cycle.getId())));
        log.info("Pilot cycle {} done: {}", cycle.getId(), cycle.getSummary());

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "completed");
        out.put("cycleId", cycle.getId());
        out.put("summary", cycle.getSummary());
        return out;
    }

    /**
     * The per-job /apply workflow. Returns submitted | queued | skipped | mail_failed.
     * Saves after every stage so the dashboard sees the job move through the pipeline.
     */
    private String pipeline(PilotJob p, Profile owner, Config cfg, boolean emailAllowed) {
        Job job = p.getJobId() == null ? null : jobRepo.findById(p.getJobId()).orElse(null);
        if (job == null) {
            p.setStage("skipped");
            p.setSkipReason("posting no longer in the job catalogue (purged/expired)");
            logStage(p, "skipped", p.getSkipReason());
            return "skipped";
        }
        String jd = descriptions.fetch(job);

        // Stage 1 — evaluate (6-dimension framework + verdict gate).
        FitEvaluationService.Evaluation eval = evaluator.evaluate(job, jd, owner);
        p.setEvaluation(eval.json());
        p.setFitScore(eval.weightedScore());
        p.setVerdict(eval.verdict());
        p.setStage("evaluated");
        logStage(p, "evaluated", eval.verdict() + " fit " + eval.weightedScore()
                + "/100 · location " + eval.locationResult());
        pilotJobs.save(p);

        if ("fail".equals(eval.locationResult())) {
            p.setStage("skipped");
            p.setSkipReason("location gate: FAIL — role requires relocation/on-site outside the candidate's area");
            logStage(p, "skipped", p.getSkipReason());
            return "skipped";
        }
        if (eval.weightedScore() < cfg.minFitScore()) {
            p.setStage("skipped");
            p.setSkipReason(eval.verdict() + " fit (" + eval.weightedScore()
                    + ") — below the auto-apply bar (" + cfg.minFitScore()
                    + "); the framework applies only on strong/good fits");
            logStage(p, "skipped", p.getSkipReason());
            return "skipped";
        }

        // Stage 2 — draft tailored CV + cover letter.
        DrafterService.Draft draft = drafter.draft(p.getUserId(), job, jd, owner, eval, cfg.tailorCv());
        p.setCvLatex(draft.cvLatex());
        p.setCoverLetter(draft.coverLetter());
        p.setStage("drafted");
        logStage(p, "drafted", draft.cvLatex() == null
                ? "cover letter drafted (no base LaTeX resume — profile resume PDF will be attached)"
                : "tailored CV + cover letter drafted");
        pilotJobs.save(p);

        // Stage 3 — independent reviewer critique.
        if (cfg.reviewerEnabled()) {
            try {
                String feedback = reviewer.review(job, jd, owner, p.getCvLatex(), p.getCoverLetter());
                p.setReviewerFeedback(feedback);
                p.setStage("reviewed");
                logStage(p, "reviewed", "independent reviewer critique received");
                pilotJobs.save(p);

                // Stage 4 — revise per feedback.
                DrafterService.Revision rev = drafter.revise(p.getCvLatex(), p.getCoverLetter(), feedback);
                p.setCvLatex(rev.cvLatex());
                p.setCoverLetter(rev.coverLetter());
                p.setRevisionNotes(rev.notes());
                p.setStage("revised");
                logStage(p, "revised", firstLine(rev.notes()));
                pilotJobs.save(p);
            } catch (Exception e) {
                log.warn("Reviewer/revise stage failed for '{}' ({}); continuing with the draft",
                        p.getJobTitle(), e.getMessage());
                logStage(p, "revised", "reviewer stage failed (" + e.getMessage() + ") — draft kept as-is");
            }
        }

        // Stage 5 — compile + ATS verify.
        byte[] cvPdf = null;
        if (p.getCvLatex() != null) {
            try {
                CompileVerifyService.Compiled c = compiler.compileCv(p.getCvLatex());
                cvPdf = c.pdf();
                p.setCvLatex(c.latex());
                p.setCvPdf(cvPdf);
                p.setStage("compiled");
                logStage(p, "compiled", c.note());
            } catch (Exception e) {
                logStage(p, "compiled", "compile failed (" + firstLine(e.getMessage())
                        + ") — falling back to the profile resume PDF");
            }
            pilotJobs.save(p);
        }
        if (cvPdf == null) {
            cvPdf = owner.getResumeData(); // profile's uploaded resume as the fallback attachment
        }
        if (cvPdf != null) {
            p.setAtsReport(compiler.verify(cvPdf, owner, eval.requiredKeywords(), eval.preferredKeywords()));
        }
        byte[] coverPdf = compiler.coverPdf(p.getCoverLetter());
        p.setCoverPdf(coverPdf);
        p.setStage("verified");
        logStage(p, "verified", atsSummary(p.getAtsReport()));
        p.setTailoringSummary(tailoringSummary(p, eval));
        pilotJobs.save(p);

        // Stage 6 — submit (email) or queue (portal/ATS for the extension).
        boolean emailJob = "email".equalsIgnoreCase(p.getJobApplyType()) && !isBlank(p.getJobApplyEmail());
        if (emailJob && cvPdf == null) {
            p.setStage("skipped");
            p.setSkipReason("no CV available to attach — upload a resume in Profile or create a base LaTeX resume");
            logStage(p, "skipped", p.getSkipReason());
            return "skipped";
        }
        if (emailJob && emailAllowed) {
            try {
                String subject = "Application: " + job.getTitle() + " — " + owner.getFullName();
                String cvName = (safe(owner.getFullName()).replaceAll("[^A-Za-z0-9 ]", "").trim()
                        + " - CV.pdf").trim();
                mail.sendWithAttachments(p.getJobApplyEmail(), subject, emailBody(owner, p.getCoverLetter()),
                        List.of(new MailAttachment(cvName, cvPdf),
                                new MailAttachment("Cover Letter.pdf", coverPdf)),
                        owner.getEmail());
                Application app = applications.markEmailApplied(job.getId(), p.getCoverLetter());
                p.setApplicationId(app.getId());
                p.setStage("submitted");
                logStage(p, "submitted", "emailed to " + p.getJobApplyEmail()
                        + " with tailored CV + cover letter");
                applications.logEvent(app.getId(), "pilot",
                        Map.of("pilotJobId", String.valueOf(p.getId()), "fit", p.getFitScore()));
                return "submitted";
            } catch (Exception e) {
                p.setError("send failed: " + e.getMessage());
                logStage(p, "verified", "send failed: " + firstLine(e.getMessage()));
                return "mail_failed";
            }
        }
        // Portal/ATS job (or email budget exhausted): hand to the extension queue.
        p.setStage("queued");
        p.setQueueStatus("pending");
        logStage(p, "queued", emailJob
                ? "email budget/backoff active — queued for manual send"
                : "portal apply (" + safe(p.getJobApplyType()) + ") — queued for the extension with tailored documents ready");
        return "queued";
    }

    // ---- queue + reads (dashboard & extension) ---------------------------------------

    public List<PilotCycle> cycleHistory(int limit) {
        return cycles.findByUserIdOrderByStartedAtDesc(ownerUserId(),
                PageRequest.of(0, Math.min(Math.max(limit, 1), 100)));
    }

    public List<PilotJobRepository.Summary> jobs(String stage, int limit) {
        UUID userId = ownerUserId();
        PageRequest page = PageRequest.of(0, Math.min(Math.max(limit, 1), 300));
        return (stage == null || stage.isBlank())
                ? pilotJobs.findByUserIdOrderByUpdatedAtDesc(userId, page)
                : pilotJobs.findByUserIdAndStageOrderByUpdatedAtDesc(userId, stage, page);
    }

    public List<PilotJobRepository.Summary> cycleJobs(UUID cycleId) {
        return pilotJobs.findByCycleIdOrderByUpdatedAtDesc(cycleId);
    }

    public List<PilotJobRepository.Summary> queue(int limit) {
        return pilotJobs.findByUserIdAndQueueStatusOrderByFitScoreDesc(ownerUserId(), "pending",
                PageRequest.of(0, Math.min(Math.max(limit, 1), 300)));
    }

    /** Full artifact view for one pipeline job (PDF bytes excluded — served separately). */
    public Map<String, Object> jobDetail(UUID id) {
        PilotJob p = pilotJob(id);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", p.getId());
        out.put("cycleId", p.getCycleId());
        out.put("jobId", p.getJobId());
        out.put("applicationId", p.getApplicationId());
        out.put("jobTitle", p.getJobTitle());
        out.put("jobCompany", p.getJobCompany());
        out.put("jobLocation", p.getJobLocation());
        out.put("jobUrl", p.getJobUrl());
        out.put("jobApplyType", p.getJobApplyType());
        out.put("matchScore", p.getMatchScore());
        out.put("stage", p.getStage());
        out.put("stageLog", p.getStageLog());
        out.put("skipReason", p.getSkipReason());
        out.put("error", p.getError());
        out.put("evaluation", p.getEvaluation());
        out.put("fitScore", p.getFitScore());
        out.put("verdict", p.getVerdict());
        out.put("cvLatex", p.getCvLatex());
        out.put("coverLetter", p.getCoverLetter());
        out.put("reviewerFeedback", p.getReviewerFeedback());
        out.put("revisionNotes", p.getRevisionNotes());
        out.put("atsReport", p.getAtsReport());
        out.put("tailoringSummary", p.getTailoringSummary());
        out.put("queueStatus", p.getQueueStatus());
        out.put("hasCvPdf", p.getCvPdf() != null && p.getCvPdf().length > 0);
        out.put("hasCoverPdf", p.getCoverPdf() != null && p.getCoverPdf().length > 0);
        out.put("createdAt", p.getCreatedAt());
        out.put("updatedAt", p.getUpdatedAt());
        return out;
    }

    public byte[] cvPdf(UUID id) {
        byte[] b = pilotJob(id).getCvPdf();
        if (b == null || b.length == 0) throw new NotFoundException("no compiled CV PDF for this job");
        return b;
    }

    public byte[] coverPdf(UUID id) {
        byte[] b = pilotJob(id).getCoverPdf();
        if (b == null || b.length == 0) throw new NotFoundException("no cover-letter PDF for this job");
        return b;
    }

    /** Queue transitions from the dashboard/extension: opened | applied | dismissed. */
    public Map<String, Object> updateQueue(UUID id, String status) {
        PilotJob p = pilotJob(id);
        if (!Set.of("pending", "opened", "applied", "dismissed").contains(status)) {
            throw new IllegalArgumentException("invalid queue status: " + status);
        }
        p.setQueueStatus(status);
        p.setUpdatedAt(Instant.now());
        if ("applied".equals(status)) {
            logStage(p, "queued", "user submitted on the portal — logged to Applications");
            if (p.getApplicationId() == null && p.getJobId() != null && jobRepo.existsById(p.getJobId())) {
                Application app = applications.track(p.getJobId());
                app = applications.update(app.getId(), "applied", null);
                p.setApplicationId(app.getId());
            }
        } else if ("dismissed".equals(status)) {
            logStage(p, "queued", "dismissed by the user");
        }
        pilotJobs.save(p);
        return Map.of("id", p.getId().toString(), "queueStatus", p.getQueueStatus());
    }

    private PilotJob pilotJob(UUID id) {
        PilotJob p = pilotJobs.findById(id)
                .orElseThrow(() -> new NotFoundException("pipeline job not found: " + id));
        UUID ctx = UserContext.get();
        if (ctx != null && p.getUserId() != null && !ctx.equals(p.getUserId())) {
            throw new NotFoundException("pipeline job not found: " + id);
        }
        return p;
    }

    // ---- helpers -----------------------------------------------------------------

    private UUID ownerUserId() {
        UUID ctx = UserContext.get();
        if (ctx != null) return ctx;
        return profiles.getOwner().getUserId();
    }

    /** Append {stage, at, note} to the job's visible timeline. */
    private void logStage(PilotJob p, String stage, String note) {
        try {
            ArrayNode arr = p.getStageLog() == null
                    ? mapper.createArrayNode()
                    : (ArrayNode) mapper.readTree(p.getStageLog());
            ObjectNode entry = mapper.createObjectNode();
            entry.put("stage", stage);
            entry.put("at", Instant.now().toString());
            entry.put("note", note == null ? "" : note);
            arr.add(entry);
            p.setStageLog(mapper.writeValueAsString(arr));
        } catch (Exception e) {
            log.debug("stage log append failed: {}", e.getMessage());
        }
    }

    private static String quickFit(Integer score) {
        if (score == null) return "unknown";
        return score >= 60 ? "high" : score >= 40 ? "medium" : "low";
    }

    /** The framework's "3-5 key tailoring decisions" — composed from real artifacts. */
    private String tailoringSummary(PilotJob p, FitEvaluationService.Evaluation eval) {
        StringBuilder sb = new StringBuilder();
        sb.append("• Verdict: ").append(eval.verdict()).append(" fit, ")
          .append(eval.weightedScore()).append("/100 weighted.");
        try {
            var n = mapper.readTree(eval.json());
            var strengths = n.path("strengths");
            if (strengths.isArray() && !strengths.isEmpty()) {
                sb.append("\n• Led with: ").append(strengths.get(0).asText());
            }
            var gaps = n.path("gaps");
            if (gaps.isArray() && !gaps.isEmpty()) {
                sb.append("\n• Gap handled honestly: ").append(gaps.get(0).asText());
            }
        } catch (Exception ignored) { /* summary is best-effort */ }
        if (p.getRevisionNotes() != null && !p.getRevisionNotes().isBlank()) {
            sb.append("\n• Reviewer impact: ").append(firstLine(p.getRevisionNotes()));
        }
        sb.append("\n• ").append(atsSummary(p.getAtsReport()));
        return sb.toString();
    }

    private String atsSummary(String atsReport) {
        if (atsReport == null) return "ATS check not run (no CV PDF)";
        try {
            var n = mapper.readTree(atsReport);
            return "ATS: " + n.path("requiredCoveragePct").asInt(0) + "% required-keyword coverage, "
                    + (n.path("hasEmail").asBoolean() || n.path("hasPhone").asBoolean()
                        ? "contact details readable" : "CONTACT DETAILS MISSING from text layer")
                    + (n.path("garbled").asBoolean() ? ", garbled glyphs detected" : "");
        } catch (Exception e) {
            return "ATS report unreadable";
        }
    }

    private String emailBody(Profile profile, String letter) {
        StringBuilder sb = new StringBuilder();
        sb.append(letter).append("\n\n");
        if (!isBlank(profile.getEmail())) sb.append(profile.getEmail()).append("\n");
        if (!isBlank(profile.getPhone())) sb.append(profile.getPhone()).append("\n");
        if (profile.getLinks() != null) {
            profile.getLinks().forEach((k, v) -> {
                if (v != null && !v.isBlank()) sb.append(k).append(": ").append(v).append("\n");
            });
        }
        return sb.toString();
    }

    private static String firstLine(String s) {
        if (s == null) return "";
        int nl = s.indexOf('\n');
        String line = nl < 0 ? s : s.substring(0, nl);
        return line.length() > 200 ? line.substring(0, 200) : line;
    }

    private static String safe(String s) { return s == null ? "" : s; }
    private static boolean isBlank(String s) { return s == null || s.isBlank(); }
}
