package com.jobpilot.service.cover;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
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
            You are a concise, professional career writer. You write authentic, specific
            cover letters in first person. Never invent facts not implied by the candidate's
            details. No placeholders like [Your Name]; sign off with the real name. Output
            ONLY the letter body — no subject line, no preamble.""";

    private final AiService ai;
    private final TemplateCoverLetterProvider template;

    public CoverLetterService(AiService ai, TemplateCoverLetterProvider template) {
        this.ai = ai;
        this.template = template;
    }

    public String generate(Job job, Profile profile) {
        if (!ai.isEnabled()) return template.generate(job, profile);
        try {
            String letter = ai.complete(SYSTEM, CoverLetterPrompt.build(job, profile), false);
            if (letter == null || letter.isBlank()) throw new IllegalStateException("empty letter");
            return letter;
        } catch (Exception e) {
            log.warn("AI cover letter failed ({}); using template", e.getMessage());
            return template.generate(job, profile);
        }
    }
}
