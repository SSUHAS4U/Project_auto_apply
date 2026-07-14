package com.jobpilot.pilot;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.domain.ResumeDoc;
import com.jobpilot.repository.ResumeDocRepository;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * The DRAFTER role of the ai-job-search two-agent workflow (apply.md Steps 2 & 4):
 * drafts a per-job tailored CV (LaTeX, from the user's base resume document) and a
 * cover letter, then later APPLIES the independent reviewer's feedback — Part A
 * edits verbatim, Part B judgment calls via one revision pass.
 *
 * Honesty rule throughout (verbatim from the framework): never fabricate skills,
 * experience or achievements; gaps are reframed with adjacent experience or
 * acknowledged transparently.
 */
@Service
public class DrafterService {

    private static final Logger log = LoggerFactory.getLogger(DrafterService.class);

    private final AiService ai;
    private final ResumeDocRepository resumeDocs;
    private final ObjectMapper mapper = new ObjectMapper();

    public DrafterService(AiService ai, ResumeDocRepository resumeDocs) {
        this.ai = ai;
        this.resumeDocs = resumeDocs;
    }

    public record Draft(String cvLatex, String coverLetter) {}
    public record Revision(String cvLatex, String coverLetter, String notes) {}

    // ---- Step 2: draft ------------------------------------------------------------

    private static final String CV_SYSTEM = """
            You are the DRAFTER in a two-agent job-application workflow. Tailor the given
            base CV (LaTeX) to the given job posting.

            Rules:
            1. HONESTY: never invent employers, titles, degrees, projects, dates, metrics or
               skills not present in the base CV or candidate profile. Rewording, reordering
               and re-emphasis only. Gaps stay visible — reframe with adjacent experience.
            2. Tailor the profile/summary line and experience bullets to THIS posting's
               requirements, mirroring the posting's exact terminology where genuinely
               supported (ATS keywords).
            3. Reorder skills so posting-relevant ones lead, spelled the way the posting
               spells them.
            4. Keep the SAME LaTeX structure, packages and page budget as the base document.
               Escape special characters (&, %, #, _) exactly like the original does.
            Output ONLY the complete LaTeX source — no fences, no commentary.""";

    private static final String LETTER_SYSTEM = """
            You are the DRAFTER in a two-agent job-application workflow. Write the cover
            letter for this application.

            Rules:
            1. HONESTY: only facts from the candidate block. Never claim tenure, employers
               or skills not listed. If the role wants more experience than the candidate
               has, lead with relevant projects/skills and clear direction — never fake it.
            2. Ground it in the posting: name 2-3 concrete things the role needs and tie each
               to the candidate's REAL experience (use the fit evaluation's strengths).
            3. Structure: strong opening hook about the role/company (never "As a ...");
               1-2 body paragraphs connecting candidate evidence to role needs; short close
               with clear interest. 150-250 words.
            4. No clichés: banned — "highly motivated", "detail-oriented", "quick learner",
               "team player", "fast-paced environment", "passion for technology".
            5. Plain text only. End with the candidate's real name on its own line.""";

    public Draft draft(UUID userId, Job job, String jd, Profile profile,
                       FitEvaluationService.Evaluation eval, boolean tailorCv) {
        String cvLatex = null;
        if (tailorCv) {
            ResumeDoc base = resumeDocs.findFirstByUserIdAndBaseTrue(userId).orElse(null);
            if (base != null && base.getLatex() != null && !base.getLatex().isBlank()) {
                cvLatex = draftCv(base.getLatex(), job, jd);
            }
        }
        String letter = draftLetter(job, jd, profile, eval);
        return new Draft(cvLatex, letter);
    }

    private String draftCv(String baseLatex, Job job, String jd) {
        try {
            String out = ai.complete(CV_SYSTEM,
                    "BASE CV (LaTeX):\n" + baseLatex
                            + "\n\nJOB POSTING (" + safe(job.getTitle()) + " @ " + safe(job.getCompany()) + "):\n"
                            + FitEvaluationService.clip(jd, 5000)
                            + "\n\nTailored LaTeX:", false, false);
            String latex = stripFences(out);
            int dc = latex.indexOf("\\documentclass");
            if (dc > 0) latex = latex.substring(dc);
            if (latex.contains("\\documentclass") && !latex.contains("\\end{document}")
                    && latex.length() > baseLatex.length() / 2) {
                latex = latex + "\n\\end{document}\n";
            }
            if (latex.contains("\\documentclass") && latex.contains("\\end{document}")) return latex;
            log.warn("CV draft was not a valid LaTeX document — using the base CV untailored");
        } catch (Exception e) {
            log.warn("CV draft failed ({}); using the base CV untailored", e.getMessage());
        }
        return baseLatex;
    }

    private String draftLetter(Job job, String jd, Profile profile, FitEvaluationService.Evaluation eval) {
        String user = "CANDIDATE:\n" + FitEvaluationService.profileBlock(profile)
                + (isBlank(profile.getCoverLetterTemplate()) ? ""
                        : "\n\nCANDIDATE'S PREFERRED STYLE (their own template — match its voice):\n"
                          + FitEvaluationService.clip(profile.getCoverLetterTemplate(), 1200))
                + "\n\nFIT EVALUATION (use the strengths; be honest about the gaps):\n"
                + FitEvaluationService.clip(eval.json(), 1500)
                + "\n\nJOB POSTING (" + safe(job.getTitle()) + " @ " + safe(job.getCompany()) + "):\n"
                + FitEvaluationService.clip(jd, 5000)
                + "\n\nCover letter:";
        String letter = ai.complete(LETTER_SYSTEM, user, false, false);
        if (letter == null || letter.isBlank()) throw new IllegalStateException("empty cover letter draft");
        return stripFences(letter);
    }

    // ---- Step 4: revise per reviewer feedback ---------------------------------------

    private static final String REVISE_SYSTEM = """
            You are the DRAFTER revising your CV and cover letter after an independent
            reviewer's critique. Apply the reviewer's Part B suggestions by category:
            weave missed keywords into experience bullets where genuinely supported; work
            company angles into the letter; rewrite passive phrasing into active; fix tone.

            HONESTY: skip any suggestion that would require inventing skills, experience or
            achievements — note it as skipped instead.

            Output STRICT JSON only: {"cvLatex":"...complete LaTeX or null if no CV...",
            "coverLetter":"...","notes":"one line per change applied or skipped"}""";

    /**
     * Part A edits (exact old→new strings from the reviewer) are applied verbatim,
     * like the framework's Edit-tool step; Part B goes through one AI revision pass.
     */
    public Revision revise(String cvLatex, String coverLetter, String reviewerFeedback) {
        StringBuilder notes = new StringBuilder();

        // Part A: deterministic edits.
        int applied = 0;
        try {
            JsonNode edits = mapper.readTree(FitEvaluationService.extractJson(reviewerFeedback)).path("edits");
            if (edits.isArray()) {
                for (JsonNode e : edits) {
                    String target = e.path("target").asText("");
                    String oldS = e.path("old").asText("");
                    String newS = e.path("new").asText("");
                    if (oldS.isBlank() || oldS.equals(newS)) continue;
                    if ("cv".equals(target) && cvLatex != null && cvLatex.contains(oldS)) {
                        cvLatex = cvLatex.replace(oldS, newS);
                        applied++;
                    } else if ("letter".equals(target) && coverLetter != null && coverLetter.contains(oldS)) {
                        coverLetter = coverLetter.replace(oldS, newS);
                        applied++;
                    }
                }
            }
        } catch (Exception e) {
            log.debug("no parseable Part A edits: {}", e.getMessage());
        }
        if (applied > 0) notes.append("Applied ").append(applied).append(" exact reviewer edits (Part A).\n");

        // Part B: one judgment-call revision pass.
        try {
            String out = ai.complete(REVISE_SYSTEM,
                    "REVIEWER FEEDBACK:\n" + FitEvaluationService.clip(reviewerFeedback, 4000)
                            + "\n\nCURRENT CV (LaTeX):\n" + (cvLatex == null ? "(no CV — letter only)" : cvLatex)
                            + "\n\nCURRENT COVER LETTER:\n" + coverLetter
                            + "\n\nRevised JSON:", false, false);
            JsonNode n = mapper.readTree(FitEvaluationService.extractJson(out));
            String newCv = n.path("cvLatex").isNull() ? null : n.path("cvLatex").asText(null);
            String newLetter = n.path("coverLetter").asText(null);
            if (cvLatex != null && newCv != null && newCv.contains("\\documentclass")
                    && newCv.contains("\\end{document}")) {
                cvLatex = newCv;
            }
            if (newLetter != null && !newLetter.isBlank()) coverLetter = newLetter;
            notes.append(n.path("notes").asText(""));
        } catch (Exception e) {
            log.warn("Part B revision pass failed ({}); keeping Part A result", e.getMessage());
            notes.append("Part B revision pass failed: ").append(e.getMessage());
        }
        return new Revision(cvLatex, coverLetter, notes.toString().trim());
    }

    private static String stripFences(String s) {
        if (s == null) return "";
        String t = s.trim();
        if (t.startsWith("```")) t = t.replaceAll("(?s)^```(latex|tex|text)?\\s*", "").replaceAll("```\\s*$", "");
        return t.trim();
    }

    private static String safe(String s) { return s == null ? "" : s; }
    private static boolean isBlank(String s) { return s == null || s.isBlank(); }
}
