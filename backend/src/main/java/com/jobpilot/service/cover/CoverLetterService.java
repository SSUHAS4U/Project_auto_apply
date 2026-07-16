package com.jobpilot.service.cover;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.JobDescriptionService;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Generates a tailored cover letter via the configured AI provider, falling back
 * to the deterministic template if AI is unavailable or fails.
 */
@Service
public class CoverLetterService {

    private static final Logger log = LoggerFactory.getLogger(CoverLetterService.class);

    private static final String SYSTEM = """
            You write cover letters that hiring managers actually read — specific, human, and
            tailored to the exact job. Follow ALL rules strictly:

            1. TRUTH ONLY. Use ONLY the facts in the candidate block. NEVER invent years of
               experience, employers, job titles, or technologies. If the candidate is early-career
               and the role wants more, be honest and lead with relevant projects/skills + clear
               eagerness — do NOT claim tenure (e.g. never write "my seven years…") or skills not listed.
            2. GROUND IT in the job description: name 2-3 concrete things the role needs and tie
               them to the candidate's REAL skills.
            3. BANNED phrases (never use any): "highly motivated", "detail-oriented",
               "detail-driven", "quick learner", "strong work ethic", "passion for technology",
               "passion for software", "thrive in", "eager to learn", "fast-paced environment",
               "team player", "make me an ideal fit/candidate".
            4. Don't just list skills — connect specific skills to specific responsibilities from THIS job.
            5. VARY the opening — never start with "As a ...". Open with a hook about the role,
               the product, or a relevant strength.
            6. 110-170 words. One or two tight paragraphs. Confident, plain, first person, honest.
            7. Output ONLY the letter body. End with the candidate's real name on its own line.
               No subject line, no "Dear Hiring Manager".""";

    private final AiService ai;
    private final TemplateCoverLetterProvider template;
    private final JobDescriptionService descriptions;

    public CoverLetterService(AiService ai, TemplateCoverLetterProvider template,
                              JobDescriptionService descriptions) {
        this.ai = ai;
        this.template = template;
        this.descriptions = descriptions;
    }

    public String generate(Job job, Profile profile) {
        return generate(job, profile, null);
    }

    /**
     * Same as {@link #generate(Job, Profile)} but accepts a pre-fetched job description so
     * callers that already hold the posting text (e.g. the Auto Apply engine) skip the
     * on-demand fetch. Falls back to the user's cover-letter template if AI is off/fails.
     */
    public String generate(Job job, Profile profile, String description) {
        if (!ai.isEnabled()) return template.generate(job, profile);
        try {
            String desc = (description != null && !description.isBlank()) ? description : descriptions.fetch(job);
            // Not cacheable: we want fresh, varied output each time rather than a repeated blob.
            String letter = ai.complete(SYSTEM, CoverLetterPrompt.build(job, profile, desc), false, false);
            if (letter == null || letter.isBlank()) throw new IllegalStateException("empty letter");
            return letter;
        } catch (Exception e) {
            log.warn("AI cover letter failed ({}); using template", e.getMessage());
            return template.generate(job, profile);
        }
    }
}
