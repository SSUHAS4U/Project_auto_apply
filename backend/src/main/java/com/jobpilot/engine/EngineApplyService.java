package com.jobpilot.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jobpilot.service.MailAttachment;
import com.jobpilot.service.MailService;
import com.jobpilot.service.ai.AiService;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * /apply — the repo's drafter→reviewer pipeline, clean-room:
 *
 *  parse → evaluate fit (5 dimensions) → draft CV+letter (LaTeX from the engine's own
 *  templates) → reviewer agent (fresh context) → revise → compile PDFs (CV must be
 *  ≤2 pages: relevance-weighted line cutting when it overflows; letter 1 page) →
 *  ATS text-layer verification (contact as literal text, keyword coverage, honesty
 *  rule: gaps acknowledged, never stuffed) → ready (or submit by email).
 *
 * Shared plumbing only: AI completion, LaTeX→PDF compile, PDFBox, mail.
 */
@Service
public class EngineApplyService {

    private static final Logger log = LoggerFactory.getLogger(EngineApplyService.class);

    private final EngineApplicationRepository apps;
    private final EngineJobRepository jobs;
    private final EngineSetupService setup;
    private final EngineScraperService scraper;
    private final AiService ai;
    private final MailService mail;
    private final com.jobpilot.service.SettingsService settings;
    private final com.jobpilot.service.ResumeDocService resumeDocs;         // tailor base résumé + compileLatex
    private final com.jobpilot.service.cover.CoverLetterService coverLetters; // reuse the app's cover-letter service
    private final com.jobpilot.repository.ProfileRepository profileRepo;      // app Profile by userId (for cover letter)
    private final com.jobpilot.service.NotificationService notifications;     // bell: package ready / failed
    private final ObjectMapper mapper = new ObjectMapper();
    private final ExecutorService pool = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "engine-apply");
        t.setDaemon(true);
        return t;
    });

    public EngineApplyService(EngineApplicationRepository apps, EngineJobRepository jobs,
                              EngineSetupService setup, EngineScraperService scraper,
                              AiService ai, MailService mail,
                              com.jobpilot.service.SettingsService settings,
                              com.jobpilot.service.ResumeDocService resumeDocs,
                              com.jobpilot.service.cover.CoverLetterService coverLetters,
                              com.jobpilot.repository.ProfileRepository profileRepo,
                              com.jobpilot.service.NotificationService notifications) {
        this.apps = apps;
        this.jobs = jobs;
        this.setup = setup;
        this.scraper = scraper;
        this.ai = ai;
        this.mail = mail;
        this.settings = settings;
        this.resumeDocs = resumeDocs;
        this.coverLetters = coverLetters;
        this.profileRepo = profileRepo;
        this.notifications = notifications;
    }

    // ---- entry points ---------------------------------------------------------

    /** Start /apply for a scraped job, a raw URL, or pasted posting text. Async. */
    public EngineApplication start(UUID userId, UUID jobId, String url, String pastedText) {
        if (!ai.isEnabled()) throw new IllegalStateException("No AI provider configured.");
        if (!setup.isReady(userId)) throw new IllegalStateException("Run Setup first — profile documents missing.");

        EngineApplication a = new EngineApplication();
        a.setUserId(userId);
        if (jobId != null) {
            EngineJob j = jobs.findById(jobId)
                    .filter(x -> x.getUserId().equals(userId))
                    .orElseThrow(() -> new NoSuchElementException("job not found"));
            a.setJobId(j.getId());
            a.setPostingUrl(j.getUrl());
            a.setPostingTitle(j.getTitle());
            a.setPostingCompany(j.getCompany());
            a.setPostingText(j.getDescription());
            j.setStatus("applying");
            jobs.save(j);
        } else {
            a.setPostingUrl(url);
            a.setPostingText(pastedText);
        }
        a.setStage("parsing");
        a = apps.save(a);
        UUID id = a.getId();
        pool.submit(() -> pipeline(id));
        return a;
    }

    // ---- the pipeline -----------------------------------------------------------

    private void pipeline(UUID appId) {
        EngineApplication a = apps.findById(appId).orElse(null);
        if (a == null) return;
        try {
            EngineProfile p = setup.get(a.getUserId());

            // 1. parse
            stage(a, "parsing", "Reading the posting");
            if (blank(a.getPostingText()) && !blank(a.getPostingUrl())) {
                a.setPostingText(scraper.fetchDescription(a.getPostingUrl()));
            }
            if (blank(a.getPostingText()))
                throw new IllegalStateException("Could not read the posting (empty description).");
            if (blank(a.getPostingTitle())) inferTitle(a);
            save(a);

            // 2. evaluate — the repo's 5 dimensions
            stage(a, "evaluating", "Scoring fit across 5 dimensions");
            JsonNode eval = evaluate(p, a);
            a.setEvaluation(eval.toString());
            a.setFitScore(eval.path("overall").asInt(0));
            a.setVerdict(eval.path("verdict").asText(""));
            save(a);
            // Only veto on a real deal-breaker the candidate set. A location "FAIL" alone
            // does NOT veto — the target locations were chosen deliberately, and the model
            // wrongly flags any job outside the home city as "requires relocation". It's
            // recorded as a note, not a silent kill.
            if (eval.path("dealBreaker").asBoolean(false)) {
                a.setStage("vetoed");
                logStage(a, "vetoed", eval.path("recommendation").asText("Deal-breaker matched"));
                save(a);
                return;
            }

            // 3. draft
            stage(a, "drafting", "Tailoring CV + cover letter");
            a.setCvLatex(draftCv(p, a, eval));
            a.setCoverLatex(draftCover(p, a, eval));
            save(a);

            // 4 + 5. reviewer + revise — the quality-refinement pass. It doubles the AI
            // calls per application (3 -> 6), which quickly exhausts free AI tiers, so it's
            // OFF by default. Turn on "thorough" mode when you have AI headroom.
            if (isThorough()) {
                stage(a, "reviewing", "Independent reviewer critiquing the drafts");
                a.setReviewerFeedback(review(p, a));
                save(a);
                stage(a, "revising", "Applying reviewer feedback");
                revise(p, a);
                save(a);
            }

            // 6. render the PDFs in-process (never fails on an external compile service)
            stage(a, "compiling", "Building the CV + cover letter PDFs");
            renderPdfs(a);
            save(a);

            // 7. ATS text-layer verification
            stage(a, "verifying", "ATS text-layer + keyword coverage check");
            a.setAtsReport(verify(p, a, eval).toString());
            save(a);

            a.setStage("ready");
            logStage(a, "ready", "Application package ready — CV " + a.getCvPages() + "p, letter "
                    + a.getCoverPages() + "p");
            save(a);
            notify(a, "engine_ready", "Application ready — " + nz(a.getPostingTitle()),
                    (blank(a.getPostingCompany()) ? "" : a.getPostingCompany() + " · ")
                            + "CV + cover letter tailored & verified. Open Auto Apply → Applications to send.");
        } catch (Exception e) {
            log.warn("apply pipeline failed for {}: {}", appId, e.getMessage());
            a.setStage("failed");
            a.setError(e.getMessage());
            logStage(a, "failed", e.getMessage());
            save(a);
            notify(a, "engine_failed", "Application failed — " + nz(a.getPostingTitle()), e.getMessage());
        }
    }

    /** Bell notification for pipeline milestones; never lets a notify error break the run. */
    private void notify(EngineApplication a, String type, String title, String body) {
        try {
            notifications.create(a.getUserId(), type, title, body,
                    Map.of("applicationId", String.valueOf(a.getId())));
        } catch (Exception e) {
            log.warn("notification failed: {}", e.getMessage());
        }
    }

    // ---- stage 2: evaluate ------------------------------------------------------

    // The exact ai-job-search Job Evaluation Framework (04-job-evaluation.md). Each
    // dimension is scored 0-100 against its band definitions; the overall is a fixed
    // weighted average (Technical 30 / Experience 25 / Behavioral 15 / Career 30, location
    // unweighted) computed deterministically below — never left to the model's judgement.
    private static final String EVAL_SYS = """
            You are a rigorous job-fit evaluator applying a fixed framework. Score each
            dimension 0-100 strictly against its band definitions, honest and critical:

            1. technical — 80-100: core requirements are the candidate's PRIMARY skills;
               60-79: most requirements match, 1-2 learnable gaps; 40-59: partial match,
               significant upskilling needed; 0-39: fundamental mismatch.
            2. experience — 80-100: direct experience in the same domain and role type;
               60-79: related, transferable experience; 40-59: adjacent, must make the case;
               0-39: unrelated. (Early-career candidates score HIGH on junior roles, LOW on
               senior ones.)
            3. behavioral — culture/role fit vs the candidate's behavioral profile. 80-100:
               strong match; 60-79: mostly compatible; 40-59: some friction; 0-39: significant
               mismatch.
            4. location — "PASS" (within commute, or remote/hybrid), "FAIL" (requires
               relocation — a deal-breaker), or "FLAG" (heavy/international travel — user judges).
            5. career — advances the candidate's goals and contains energizing work. 80-100:
               strongly aligned, clear growth; 60-79: good but only partially aligned; 40-59:
               doesn't build toward goals; 0-39: dead end or backwards step.

            Set "dealBreaker": true only if the evaluation lens's deal-breakers clearly apply.
            Extract requiredKeywords (must-have hard skills/tools an ATS scans) and
            preferredKeywords. Give 2-3 strengths, 1-3 honest gaps, and a 1-2 sentence
            recommendation. Every note cites something concrete. Never invent. Do NOT output an
            overall score or verdict — those are computed from your dimension scores.
            Output STRICT JSON only:
            {"technical":{"score":0,"note":""},"experience":{"score":0,"note":""},
             "behavioral":{"score":0,"note":""},"location":{"result":"PASS","note":""},
             "career":{"score":0,"note":""},"dealBreaker":false,
             "strengths":["",""],"gaps":["",""],"recommendation":"",
             "requiredKeywords":[""],"preferredKeywords":[""]}""";

    /** The framework's fixed weights + verdict bands, applied deterministically. */
    static int weightedOverall(int technical, int experience, int behavioral, int career) {
        return Math.round(technical * 0.30f + experience * 0.25f + behavioral * 0.15f + career * 0.30f);
    }
    static String verdictBand(int overall) {
        if (overall >= 75) return "strong";
        if (overall >= 60) return "good";
        if (overall >= 45) return "moderate";
        if (overall >= 30) return "weak";
        return "poor";
    }

    private JsonNode evaluate(EngineProfile p, EngineApplication a) throws Exception {
        String user = "CANDIDATE PROFILE:\n" + cap(nz(p.getCandidateMd()), 2600)
                + "\n\nBEHAVIORAL PROFILE:\n" + cap(nz(p.getBehavioralMd()), 800)
                + "\n\nEVALUATION LENS (goals, must-haves, deal-breakers):\n" + cap(nz(p.getEvaluationMd()), 1200)
                + "\n\nPOSTING (" + nz(a.getPostingTitle()) + " @ " + nz(a.getPostingCompany()) + "):\n"
                + cap(nz(a.getPostingText()), 3000);
        JsonNode ev = mapper.readTree(extractJson(completeRetry(EVAL_SYS, user)));
        // Compute overall + verdict from the dimension scores with the framework's exact weights.
        int overall = weightedOverall(
                ev.path("technical").path("score").asInt(0), ev.path("experience").path("score").asInt(0),
                ev.path("behavioral").path("score").asInt(0), ev.path("career").path("score").asInt(0));
        if (ev instanceof ObjectNode on) {
            on.put("overall", overall);
            on.put("verdict", verdictBand(overall));
        }
        return ev;
    }

    // ---- stage 3: draft -----------------------------------------------------------

    // Markdown (not LaTeX) — rendered to PDF in-process, so it never fails on a compile
    // service, and it's far easier for the model to produce correctly.
    private static final String CV_SYS = """
            You are the drafter. Produce a TAILORED résumé for this posting in clean, simple
            MARKDOWN with this exact structure:
              # Full Name
              City · email · phone · links        (one line, right after the name)
              ## Summary
              a 2-3 line summary tailored to the role
              ## Skills
              - **Languages:** ...
              - **Frameworks:** ...
              - **Tools:** ...
              ## Experience
              ### Job Title — Company (dates)
              - achievement bullet with a real outcome
              ## Projects
              ### Project — stack
              - what it does and the result
              ## Education
              ### Degree, Field — Institution (years)
            Rules: reorder/reword so the most posting-relevant items lead; use the posting's
            exact terms for skills the candidate REALLY has; **bold** labels and titles;
            STRICT HONESTY — never invent employers, titles, dates, degrees, metrics or skills;
            a required keyword the profile doesn't support stays absent. Keep it concise (fits
            ~2 pages). Output ONLY the markdown — no code fences, no commentary, no LaTeX.""";

    private static final String COVER_SYS = """
            You are the drafter. Write a tailored cover letter in clean MARKDOWN:
              # Full Name
              email · phone · city
              (blank line) Dear Hiring Manager, (or a named person if the posting gives one)
              2-3 short paragraphs: name 2-3 concrete needs from the posting and tie each to
              REAL experience; 180-260 words total; first person, specific, no clichés, no
              invented facts. End with: Sincerely, / Full Name.
            Output ONLY the markdown — no code fences, no commentary, no LaTeX.""";

    private String draftCv(EngineProfile p, EngineApplication a, JsonNode eval) {
        // Use the candidate's REAL résumé (Resumes → base), tailored to this posting via the
        // same ResumeDocService the "Tailor" button uses, then compiled to a polished PDF.
        // Only when there's no base résumé do we fall back to clean markdown generation.
        String tailored = resumeDocs.tailorLatex(a.getUserId(), a.getPostingText());
        if (tailored != null && !tailored.isBlank()) return tailored;

        String user = "POSTING:\n" + cap(nz(a.getPostingText()), 2600)
                + "\n\nREQUIRED KEYWORDS: " + join(eval.path("requiredKeywords"))
                + "\n\nWRITING STYLE RULES:\n" + cap(nz(p.getWritingStyleMd()), 800)
                + "\n\nCANDIDATE PROFILE (source of truth — use these real facts):\n" + cap(nz(p.getCandidateMd()), 3200);
        return stripFences(completeRetry(CV_SYS, user));
    }

    private String draftCover(EngineProfile p, EngineApplication a, JsonNode eval) {
        // Reuse the app's CoverLetterService (JD-grounded, honest, falls back to the user's
        // saved cover-letter template) so the engine writes letters the same way Compose does.
        com.jobpilot.domain.Profile prof = profileRepo.findByUserId(a.getUserId()).orElse(null);
        if (prof != null) {
            com.jobpilot.domain.Job job = new com.jobpilot.domain.Job();
            job.setTitle(nz(a.getPostingTitle()));
            job.setCompany(nz(a.getPostingCompany()));
            job.setDescription(nz(a.getPostingText()));
            try {
                String letter = coverLetters.generate(job, prof, a.getPostingText());
                if (letter != null && !letter.isBlank()) return letter;
            } catch (Exception e) {
                log.warn("engine cover via CoverLetterService failed, using engine drafter: {}", e.getMessage());
            }
        }
        String user = "POSTING (" + nz(a.getPostingTitle()) + " @ " + nz(a.getPostingCompany()) + "):\n"
                + cap(nz(a.getPostingText()), 2600)
                + "\n\nCANDIDATE'S TOP MATCHES: " + join(eval.path("strengths"))
                + "\n\nWRITING STYLE RULES:\n" + cap(nz(p.getWritingStyleMd()), 800)
                + "\n\nCANDIDATE PROFILE (source of truth):\n" + cap(nz(p.getCandidateMd()), 3000);
        return stripFences(completeRetry(COVER_SYS, user));
    }

    // ---- stage 4: reviewer ---------------------------------------------------------

    private static final String REVIEW_SYS = """
            You are an INDEPENDENT reviewer with fresh eyes. You did not write these drafts.
            Critique the tailored CV and cover letter against the posting and the candidate's
            real profile. Look for: missed posting keywords the candidate genuinely has,
            weak/passive framing, generic filler, company-specific angles not used, tone
            violations, fabrication risks (anything not supported by the profile), layout
            hazards (overlong sections). Organise the critique as:
            MISSED KEYWORDS: ...
            WEAK FRAMING: exact line → suggested rewrite
            COMPANY ANGLES: ...
            HONESTY FLAGS: ...
            TONE: ...
            Every suggestion must be grounded in the profile — never suggest inventing.""";

    private String review(EngineProfile p, EngineApplication a) {
        String user = "POSTING:\n" + cap(nz(a.getPostingText()), 2600)
                + "\n\nCANDIDATE PROFILE:\n" + cap(nz(p.getCandidateMd()), 2600)
                + "\n\nDRAFT CV (LaTeX):\n" + cap(nz(a.getCvLatex()), 3000)
                + "\n\nDRAFT COVER LETTER (LaTeX):\n" + cap(nz(a.getCoverLatex()), 2500);
        return completeRetry(REVIEW_SYS, user);
    }

    // ---- stage 5: revise -------------------------------------------------------------

    private static final String REVISE_SYS = """
            You are the drafter, revising after review. Apply the reviewer's critique to the
            document where it is grounded in the candidate's real profile; ignore anything
            that would require inventing facts. Keep the LaTeX compiling and the structure
            intact. Output ONLY the complete revised LaTeX source for the requested document
            (no commentary, no fences).""";

    private void revise(EngineProfile p, EngineApplication a) {
        String base = "REVIEWER CRITIQUE:\n" + cap(nz(a.getReviewerFeedback()), 3000)
                + "\n\nCANDIDATE PROFILE (source of truth):\n" + cap(nz(p.getCandidateMd()), 2600);
        String cv = completeRetry(REVISE_SYS, base + "\n\nDOCUMENT (CV):\n" + cap(nz(a.getCvLatex()), 3200));
        String cover = completeRetry(REVISE_SYS, base + "\n\nDOCUMENT (COVER LETTER):\n"
                + cap(nz(a.getCoverLatex()), 3000));
        if (!blank(cv)) a.setCvLatex(stripFences(cv));
        if (!blank(cover)) a.setCoverLatex(stripFences(cover));
        a.setRevisionNotes("Reviewer critique applied where grounded in the profile.");
    }

    // ---- stage 6: render PDFs in-process (no LaTeX, no external compile service) ------

    private void renderPdfs(EngineApplication a) {
        a.setCvPdf(toPdf(a.getCvLatex(), "cv"));
        a.setCvPages(pageCount(a.getCvPdf()));
        a.setCoverPdf(toPdf(a.getCoverLatex(), "cover"));
        a.setCoverPages(pageCount(a.getCoverPdf()));
    }

    /**
     * Hybrid render: if the draft is LaTeX (the candidate's own tailored template), compile
     * it via the external service for the polished look; if that fails, fall back to the
     * in-process renderer so it NEVER hard-fails. Plain markdown drafts render in-process.
     */
    private byte[] toPdf(String content, String which) {
        if (blank(content)) return DocPdfRenderer.render("# " + which);
        boolean isLatex = content.contains("\\documentclass") || content.contains("\\begin{document}");
        if (isLatex) {
            try {
                return resumeDocs.compileLatex(content);
            } catch (Exception e) {
                log.warn("LaTeX compile failed for {} — falling back to in-process render: {}", which, e.getMessage());
                return DocPdfRenderer.render(latexToMarkdown(content));
            }
        }
        return DocPdfRenderer.render(content);
    }

    /** Rough LaTeX → markdown so the in-process fallback stays readable when compile fails. */
    private static String latexToMarkdown(String tex) {
        String body = tex;
        int begin = body.indexOf("\\begin{document}");
        int end = body.indexOf("\\end{document}");
        if (begin >= 0) body = body.substring(begin + 16, end > begin ? end : body.length());
        return body
                .replaceAll("\\\\(sub)?section\\*?\\{([^}]*)}", "\n## $2")
                .replaceAll("\\\\cventry\\s*\\{[^}]*}\\{([^}]*)}\\{([^}]*)}.*", "\n### $1 — $2")
                .replaceAll("\\\\textbf\\{([^}]*)}", "**$1**")
                .replaceAll("\\\\(textit|emph)\\{([^}]*)}", "$2")
                .replaceAll("\\\\item\\s*", "\n- ")
                .replaceAll("\\\\[a-zA-Z]+\\*?(\\[[^]]*])?(\\{[^}]*})?", " ")
                .replaceAll("[{}$&~^\\\\]", " ")
                .replaceAll("[ \\t]+", " ")
                .replaceAll("\\n{3,}", "\n\n")
                .trim();
    }

    private int pageCount(byte[] pdf) {
        try (PDDocument doc = Loader.loadPDF(pdf)) {
            return doc.getNumberOfPages();
        } catch (Exception e) {
            return 0;
        }
    }

    // ---- stage 7: ATS verification -----------------------------------------------------

    private ObjectNode verify(EngineProfile p, EngineApplication a, JsonNode eval) {
        ObjectNode report = mapper.createObjectNode();
        try (PDDocument doc = Loader.loadPDF(a.getCvPdf())) {
            String text = new PDFTextStripper().getText(doc);
            String low = text.toLowerCase(Locale.ROOT);

            boolean hasEmail = low.matches("(?s).*[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}.*");
            boolean hasPhone = text.matches("(?s).*(\\+?\\d[\\d\\s().-]{8,}).*");
            long letters = low.chars().filter(Character::isLetter).count();
            boolean garbled = letters < 200; // a real 1-2 page CV extracts far more
            report.put("hasEmail", hasEmail);
            report.put("hasPhone", hasPhone);
            report.put("garbled", garbled);
            report.put("pages", a.getCvPages());

            // keyword coverage with the honesty rule
            String profileLow = nz(p.getCandidateMd()).toLowerCase(Locale.ROOT);
            ArrayNode covered = report.putArray("requiredCovered");
            ArrayNode missingHave = report.putArray("requiredMissingHave");   // in profile, not in CV
            ArrayNode missingGap = report.putArray("requiredMissingGap");     // honest gap — never stuffed
            int total = 0, hit = 0;
            for (JsonNode k : eval.path("requiredKeywords")) {
                String kw = k.asText().trim();
                if (kw.isEmpty()) continue;
                total++;
                if (low.contains(kw.toLowerCase(Locale.ROOT))) { covered.add(kw); hit++; }
                else if (profileLow.contains(kw.toLowerCase(Locale.ROOT))) missingHave.add(kw);
                else missingGap.add(kw);
            }
            report.put("requiredCoveragePct", total == 0 ? 100 : Math.round(hit * 100f / total));
            ArrayNode prefCovered = report.putArray("preferredCovered");
            for (JsonNode k : eval.path("preferredKeywords")) {
                String kw = k.asText().trim();
                if (!kw.isEmpty() && low.contains(kw.toLowerCase(Locale.ROOT))) prefCovered.add(kw);
            }
            report.put("ok", hasEmail && !garbled);
        } catch (Exception e) {
            report.put("ok", false);
            report.put("error", "text-layer extraction failed: " + e.getMessage());
        }
        return report;
    }

    // ---- submit by email (when the user provides/knows the address) ---------------------

    public EngineApplication submitByEmail(UUID userId, UUID appId, String to) {
        EngineApplication a = owned(userId, appId);
        if (!"ready".equals(a.getStage())) throw new IllegalStateException("Application is not ready.");
        if (blank(to)) throw new IllegalArgumentException("Recipient email required.");
        String subject = "Application: " + nz(a.getPostingTitle())
                + (blank(a.getPostingCompany()) ? "" : " — " + a.getPostingCompany());
        String body = coverAsPlainText(a);
        mail.sendWithAttachments(to.trim(), subject, body,
                List.of(new MailAttachment("CV.pdf", a.getCvPdf()),
                        new MailAttachment("Cover Letter.pdf", a.getCoverPdf())), null);
        a.setStage("submitted");
        a.setOutcome("applied");
        a.setOutcomeAt(Instant.now());
        logStage(a, "submitted", "Emailed to " + to.trim());
        if (a.getJobId() != null) jobs.findById(a.getJobId()).ifPresent(j -> {
            j.setStatus("applied");
            jobs.save(j);
        });
        return save(a);
    }

    /** /outcome — record what happened; archives are already in the row. */
    public EngineApplication recordOutcome(UUID userId, UUID appId, String outcome, String notes) {
        EngineApplication a = owned(userId, appId);
        a.setOutcome(outcome);
        a.setOutcomeNotes(notes);
        a.setOutcomeAt(Instant.now());
        if ("applied".equals(outcome) && "ready".equals(a.getStage())) a.setStage("submitted");
        logStage(a, "outcome", outcome + (blank(notes) ? "" : " — " + notes));
        if (a.getJobId() != null && "applied".equals(outcome))
            jobs.findById(a.getJobId()).ifPresent(j -> { j.setStatus("applied"); jobs.save(j); });
        return save(a);
    }

    public EngineApplication owned(UUID userId, UUID appId) {
        return apps.findById(appId).filter(x -> x.getUserId().equals(userId))
                .orElseThrow(() -> new NoSuchElementException("application not found"));
    }

    // ---- helpers ---------------------------------------------------------------------

    private String coverAsPlainText(EngineApplication a) {
        // Take the letter body out of the LaTeX for the email body (best effort).
        String src = nz(a.getCoverLatex());
        int begin = src.indexOf("\\begin{document}");
        int end = src.indexOf("\\end{document}");
        String body = (begin >= 0 && end > begin) ? src.substring(begin + 16, end) : src;
        return body.replaceAll("\\\\[a-zA-Z]+\\*?(\\[[^]]*])?(\\{[^}]*})?", " ")
                .replaceAll("[{}~$%]", " ")
                .replaceAll("\\\\\\\\", "\n")
                .replaceAll("[ \\t]+", " ")
                .replaceAll("\\n{3,}", "\n\n")
                .trim();
    }

    private void inferTitle(EngineApplication a) {
        String head = cap(nz(a.getPostingText()), 300);
        int nl = head.indexOf('\n');
        a.setPostingTitle(nl > 5 ? head.substring(0, Math.min(nl, 120)).trim()
                : head.substring(0, Math.min(head.length(), 80)).trim());
    }

    private void stage(EngineApplication a, String stage, String note) {
        a.setStage(stage);
        logStage(a, stage, note);
        save(a);
    }

    private void logStage(EngineApplication a, String stage, String note) {
        try {
            ArrayNode arr = blank(a.getStageLog())
                    ? mapper.createArrayNode()
                    : (ArrayNode) mapper.readTree(a.getStageLog());
            ObjectNode e = arr.addObject();
            e.put("stage", stage);
            e.put("at", Instant.now().toString());
            e.put("note", nz(note));
            a.setStageLog(arr.toString());
        } catch (Exception ignore) { /* the timeline is best-effort */ }
    }

    private EngineApplication save(EngineApplication a) {
        a.setUpdatedAt(Instant.now());
        return apps.save(a);
    }

    private static String join(JsonNode arr) {
        List<String> parts = new ArrayList<>();
        if (arr != null && arr.isArray()) arr.forEach(x -> parts.add(x.asText()));
        return String.join(", ", parts);
    }

    /**
     * Run an AI completion but survive transient provider hiccups (free-tier rate limits,
     * a momentary I/O error, a dead fallback provider). One flaky call should never throw
     * away a whole application's work, so we retry with backoff before giving up.
     */
    private String completeRetry(String system, String user) {
        RuntimeException last = null;
        for (int attempt = 0; attempt < 4; attempt++) {
            try {
                String out = ai.complete(system, user, false, false);
                if (out != null && !out.isBlank()) return out;
                last = new IllegalStateException("AI returned an empty response");
            } catch (RuntimeException e) {
                last = e;
            }
            // Rate limits reset per minute (Groq free = 6000 tokens/min), so a real wait
            // clears them; ordinary hiccups just need a short pause.
            long wait = isRateLimit(last) ? 18000L * (attempt + 1) : 2000L * (attempt + 1);
            try { Thread.sleep(wait); }
            catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
        }
        throw last != null ? last : new IllegalStateException("AI unavailable");
    }

    /** Thorough mode adds the reviewer+revise pass (2x the AI calls). Off by default so
     *  autopilot stays within free AI limits; toggled via the engine_thorough setting. */
    private boolean isThorough() {
        return settings.get("engine_thorough").map("true"::equals).orElse(false);
    }

    private static boolean isRateLimit(Throwable e) {
        String m = e == null ? "" : String.valueOf(e.getMessage());
        return m != null && java.util.regex.Pattern.compile(
                "429|413|rate.?limit|too many|tokens per minute|\\btpm\\b|quota|too large",
                java.util.regex.Pattern.CASE_INSENSITIVE).matcher(m).find();
    }

    private static String extractJson(String s) {
        if (s == null) return "{}";
        int a = s.indexOf('{');
        int b = s.lastIndexOf('}');
        return (a >= 0 && b > a) ? s.substring(a, b + 1) : "{}";
    }

    private static String stripFences(String s) {
        if (s == null) return "";
        String t = s.trim();
        if (t.startsWith("```")) {
            int nl = t.indexOf('\n');
            if (nl > 0) t = t.substring(nl + 1);
            if (t.endsWith("```")) t = t.substring(0, t.length() - 3);
        }
        return t.trim();
    }

    private static boolean blank(String s) { return s == null || s.isBlank(); }
    private static String nz(String s) { return s == null ? "" : s; }
    private static String cap(String s, int max) { return s.length() > max ? s.substring(0, max) : s; }
}
