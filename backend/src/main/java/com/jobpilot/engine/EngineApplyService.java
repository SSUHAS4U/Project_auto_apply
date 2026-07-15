package com.jobpilot.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jobpilot.service.MailAttachment;
import com.jobpilot.service.MailService;
import com.jobpilot.service.ResumeDocService;
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
    private final ResumeDocService latex;   // shared plumbing: compileLatex only
    private final MailService mail;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ExecutorService pool = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "engine-apply");
        t.setDaemon(true);
        return t;
    });

    public EngineApplyService(EngineApplicationRepository apps, EngineJobRepository jobs,
                              EngineSetupService setup, EngineScraperService scraper,
                              AiService ai, ResumeDocService latex, MailService mail) {
        this.apps = apps;
        this.jobs = jobs;
        this.setup = setup;
        this.scraper = scraper;
        this.ai = ai;
        this.latex = latex;
        this.mail = mail;
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
            if ("fail".equalsIgnoreCase(eval.path("location").path("result").asText(""))
                    || eval.path("dealBreaker").asBoolean(false)) {
                a.setStage("vetoed");
                logStage(a, "vetoed", eval.path("recommendation").asText("Deal-breaker or location fail"));
                save(a);
                return;
            }

            // 3. draft
            stage(a, "drafting", "Tailoring CV + cover letter");
            a.setCvLatex(draftCv(p, a, eval));
            a.setCoverLatex(draftCover(p, a, eval));
            save(a);

            // 4. reviewer agent (fresh context — sees only drafts, profile, posting)
            stage(a, "reviewing", "Independent reviewer critiquing the drafts");
            a.setReviewerFeedback(review(p, a));
            save(a);

            // 5. revise
            stage(a, "revising", "Applying reviewer feedback");
            revise(p, a);
            save(a);

            // 6. compile + page rules + relevance-weighted cutting
            stage(a, "compiling", "Compiling PDFs (CV ≤ 2 pages, letter 1 page)");
            compileWithRules(a, eval);
            save(a);

            // 7. ATS text-layer verification
            stage(a, "verifying", "ATS text-layer + keyword coverage check");
            a.setAtsReport(verify(p, a, eval).toString());
            save(a);

            a.setStage("ready");
            logStage(a, "ready", "Application package ready — CV " + a.getCvPages() + "p, letter "
                    + a.getCoverPages() + "p");
            save(a);
        } catch (Exception e) {
            log.warn("apply pipeline failed for {}: {}", appId, e.getMessage());
            a.setStage("failed");
            a.setError(e.getMessage());
            logStage(a, "failed", e.getMessage());
            save(a);
        }
    }

    // ---- stage 2: evaluate ------------------------------------------------------

    private static final String EVAL_SYS = """
            You are a rigorous job-fit evaluator. Score the candidate against the posting on
            the five dimensions of this framework, 0-100 each, honestly and critically:
            1. skills — technical requirements vs the candidate's actual capabilities.
            2. experience — role level, domain, industry alignment (early-career candidates
               score HIGH on junior roles, LOW on senior ones).
            3. culture — stated values, team structure, work environment vs the candidate's
               behavioral profile.
            4. location — remote policy, commute, relocation vs the candidate's logistics
               ("result": pass | fail | flag).
            5. career — alignment with stated goals and growth momentum; check the
               candidate's deal-breakers ("dealBreaker": true only if one clearly applies).
            overall = weighted judgment (not a plain mean). verdict: strong(75+) good(60-74)
            moderate(45-59) weak(30-44) poor(<30).
            Extract requiredKeywords (must-have hard skills/tools the ATS will scan) and
            preferredKeywords. Every note must cite something concrete.
            Output STRICT JSON only:
            {"skills":{"score":0,"note":""},"experience":{"score":0,"note":""},
             "culture":{"score":0,"note":""},"location":{"result":"pass","note":""},
             "career":{"score":0,"note":""},"overall":0,"verdict":"","dealBreaker":false,
             "strengths":["",""],"gaps":["",""],"recommendation":"",
             "requiredKeywords":[""],"preferredKeywords":[""]}""";

    private JsonNode evaluate(EngineProfile p, EngineApplication a) throws Exception {
        String user = "CANDIDATE PROFILE:\n" + cap(nz(p.getCandidateMd()), 5000)
                + "\n\nBEHAVIORAL PROFILE:\n" + cap(nz(p.getBehavioralMd()), 1500)
                + "\n\nEVALUATION LENS (goals, must-haves, deal-breakers):\n" + cap(nz(p.getEvaluationMd()), 2000)
                + "\n\nPOSTING (" + nz(a.getPostingTitle()) + " @ " + nz(a.getPostingCompany()) + "):\n"
                + cap(nz(a.getPostingText()), 6000);
        return mapper.readTree(extractJson(completeRetry(EVAL_SYS, user)));
    }

    // ---- stage 3: draft -----------------------------------------------------------

    private static final String CV_SYS = """
            You are the drafter. Produce a TAILORED LaTeX CV for this specific posting:
            - Start from the base CV LaTeX and KEEP its preamble/structure compiling.
            - Reorder and reword content so the most posting-relevant items lead.
            - Use the posting's exact terminology for skills the candidate REALLY has.
            - STRICT HONESTY: never invent employers, titles, dates, degrees, metrics or
              skills. A required keyword the profile doesn't support stays absent.
            - Follow the writing-style rules. Target 2 pages maximum.
            Output ONLY the complete LaTeX source (no commentary, no fences).""";

    private static final String COVER_SYS = """
            You are the drafter. Write a tailored cover letter as LaTeX using the given
            template structure:
            - Name 2-3 concrete needs from the posting and tie each to REAL experience.
            - 180-260 words of body. Follow the writing-style rules; obey its banned
              phrases. First person, specific, zero clichés, zero invented facts.
            - Keep the template's preamble compiling; replace placeholders.
            Output ONLY the complete LaTeX source (no commentary, no fences).""";

    private String draftCv(EngineProfile p, EngineApplication a, JsonNode eval) {
        String user = "POSTING:\n" + cap(nz(a.getPostingText()), 4500)
                + "\n\nREQUIRED KEYWORDS: " + join(eval.path("requiredKeywords"))
                + "\n\nWRITING STYLE RULES:\n" + cap(nz(p.getWritingStyleMd()), 1500)
                + "\n\nCANDIDATE PROFILE (source of truth):\n" + cap(nz(p.getCandidateMd()), 5000)
                + "\n\nBASE CV LATEX:\n" + cap(nz(p.getCvTemplateLatex()), 6000);
        return stripFences(completeRetry(CV_SYS, user));
    }

    private String draftCover(EngineProfile p, EngineApplication a, JsonNode eval) {
        String user = "POSTING (" + nz(a.getPostingTitle()) + " @ " + nz(a.getPostingCompany()) + "):\n"
                + cap(nz(a.getPostingText()), 4500)
                + "\n\nCANDIDATE'S TOP MATCHES: " + join(eval.path("strengths"))
                + "\n\nWRITING STYLE RULES:\n" + cap(nz(p.getWritingStyleMd()), 1500)
                + "\n\nCANDIDATE PROFILE (source of truth):\n" + cap(nz(p.getCandidateMd()), 4000)
                + "\n\nLETTER TEMPLATE LATEX:\n" + cap(nz(p.getCoverTemplateLatex()), 3000);
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
        String user = "POSTING:\n" + cap(nz(a.getPostingText()), 4000)
                + "\n\nCANDIDATE PROFILE:\n" + cap(nz(p.getCandidateMd()), 4000)
                + "\n\nDRAFT CV (LaTeX):\n" + cap(nz(a.getCvLatex()), 5500)
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
                + "\n\nCANDIDATE PROFILE (source of truth):\n" + cap(nz(p.getCandidateMd()), 4000);
        String cv = completeRetry(REVISE_SYS, base + "\n\nDOCUMENT (CV):\n" + cap(nz(a.getCvLatex()), 6000));
        String cover = completeRetry(REVISE_SYS, base + "\n\nDOCUMENT (COVER LETTER):\n"
                + cap(nz(a.getCoverLatex()), 3000));
        if (!blank(cv)) a.setCvLatex(stripFences(cv));
        if (!blank(cover)) a.setCoverLatex(stripFences(cover));
        a.setRevisionNotes("Reviewer critique applied where grounded in the profile.");
    }

    // ---- stage 6: compile + page rules + relevance-weighted cutting -------------------

    private static final String FIX_SYS = """
            This LaTeX failed to compile. Fix ONLY the error (undefined commands, unclosed
            environments, bad characters) without changing any content or meaning.
            Output ONLY the corrected complete LaTeX source.""";

    private static final String CUT_SYS = """
            This CV compiles to MORE than 2 pages. Apply relevance-weighted cutting:
            score each content line by (a) relevance to the posting, (b) uniqueness,
            (c) recency — then REMOVE the lowest-scoring lines until the CV plausibly fits
            2 pages. Never cut contact details, the current/most relevant role, or anything
            the cover letter depends on. Keep the LaTeX compiling. After the LaTeX, output
            nothing else. Output ONLY the complete trimmed LaTeX source.""";

    private void compileWithRules(EngineApplication a, JsonNode eval) {
        // CV: compile → repair once on error → cut down to 2 pages (max 2 passes)
        byte[] cvPdf = compileWithRepair(a.getCvLatex(), latexUpdated -> a.setCvLatex(latexUpdated));
        int pages = pageCount(cvPdf);
        StringBuilder cuts = new StringBuilder();
        for (int pass = 0; pages > 2 && pass < 2; pass++) {
            cuts.append("Pass ").append(pass + 1).append(": CV was ").append(pages)
                .append(" pages — relevance-weighted cut applied.\n");
            String trimmed = stripFences(completeRetry(CUT_SYS,
                    "POSTING KEYWORDS: " + join(eval.path("requiredKeywords"))
                            + "\n\nPOSTING (for relevance):\n" + cap(nz(a.getPostingText()), 2500)
                            + "\n\nCV LATEX:\n" + a.getCvLatex()));
            if (blank(trimmed)) break;
            a.setCvLatex(trimmed);
            cvPdf = compileWithRepair(a.getCvLatex(), l -> a.setCvLatex(l));
            pages = pageCount(cvPdf);
        }
        a.setCvPdf(cvPdf);
        a.setCvPages(pages);
        if (!cuts.isEmpty()) a.setCutReport(cuts.toString().trim());

        // Cover letter: compile → repair once; 1-page rule is checked, not force-cut.
        byte[] coverPdf = compileWithRepair(a.getCoverLatex(), l -> a.setCoverLatex(l));
        a.setCoverPdf(coverPdf);
        a.setCoverPages(pageCount(coverPdf));
    }

    private byte[] compileWithRepair(String source, java.util.function.Consumer<String> onFix) {
        try {
            return latex.compileLatex(source);
        } catch (Exception first) {
            String fixed = stripFences(completeRetry(FIX_SYS,
                    "ERROR:\n" + cap(nz(first.getMessage()), 800) + "\n\nLATEX:\n" + source));
            if (blank(fixed)) throw new IllegalStateException("LaTeX compile failed: " + first.getMessage());
            onFix.accept(fixed);
            return latex.compileLatex(fixed); // second failure propagates
        }
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
            try { Thread.sleep(2000L * (attempt + 1)); }
            catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
        }
        throw last != null ? last : new IllegalStateException("AI unavailable");
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
