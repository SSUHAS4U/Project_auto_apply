package com.jobpilot.pilot;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.ai.AiService;
import org.springframework.stereotype.Service;

/**
 * The REVIEWER role of the two-agent workflow (apply.md Step 3): an INDEPENDENT
 * critique pass with a fresh context — it never sees the drafter's instructions,
 * only the drafts inlined plus the candidate profile and posting, exactly like the
 * framework spawns a separate reviewer agent with drafts inlined (not file-read).
 *
 * Returns Part A (structured JSON edits with exact old/new strings) and Part B
 * (narrative suggestions grouped by category: missed keywords, company angles,
 * action reframing, tone issues). All suggestions must be grounded in actual
 * profile data — no fabrication.
 */
@Service
public class ReviewerService {

    private static final String SYSTEM = """
            You are an INDEPENDENT reviewer of a job application draft. You did not write
            these documents. Critique them against the posting and the candidate's actual
            profile. Be specific and hard to please.

            Ground every suggestion in the candidate's REAL profile data — never suggest
            adding skills, experience or achievements the profile doesn't support.

            Respond in exactly two parts:

            PART A — structured edits. STRICT JSON:
            {"edits":[{"target":"cv|letter","old":"<exact text currently in the draft>",
                       "new":"<replacement>","why":"<one line>"}]}
            Only include edits where "old" appears VERBATIM in the draft. Max 8 edits.

            PART B — narrative suggestions, grouped under these exact headings:
            MISSED KEYWORDS: posting terms the drafts should use (only if the profile
              genuinely supports them).
            COMPANY ANGLES: specifics about this company/role the letter should reference.
            ACTION REFRAMING: passive or weak phrasing to rewrite (quote it).
            TONE ISSUES: anything off in voice, length or clichés.""";

    private final AiService ai;

    public ReviewerService(AiService ai) {
        this.ai = ai;
    }

    public String review(Job job, String jd, Profile profile, String cvLatex, String coverLetter) {
        String user = "JOB POSTING (" + safe(job.getTitle()) + " @ " + safe(job.getCompany()) + "):\n"
                + FitEvaluationService.clip(jd, 4000)
                + "\n\nCANDIDATE PROFILE (the ground truth — nothing beyond this is real):\n"
                + FitEvaluationService.profileBlock(profile)
                + "\n\nDRAFT CV (LaTeX):\n"
                + (cvLatex == null ? "(no tailored CV in this application — review the letter only)"
                        : FitEvaluationService.clip(cvLatex, 6000))
                + "\n\nDRAFT COVER LETTER:\n" + coverLetter
                + "\n\nYour review (PART A then PART B):";
        String out = ai.complete(SYSTEM, user, false, false);
        if (out == null || out.isBlank()) throw new IllegalStateException("empty reviewer response");
        return out.trim();
    }

    private static String safe(String s) { return s == null ? "" : s; }
}
