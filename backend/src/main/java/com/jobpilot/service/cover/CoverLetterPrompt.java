package com.jobpilot.service.cover;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;

/** Shared prompt + text helpers for LLM providers. */
final class CoverLetterPrompt {

    private CoverLetterPrompt() {}

    static String build(Job job, Profile profile) {
        String skills = profile.getSkills() == null ? "" : String.join(", ", profile.getSkills());
        String descExcerpt = excerpt(job.getDescription(), 1200);
        return """
                Write a concise, professional cover letter (150-220 words) for the role below.
                Use a confident first-person voice. Do not invent facts not implied by the candidate's
                skills. No placeholders, no "[Your Name]" — sign off with the candidate's real name.

                ROLE: %s
                COMPANY: %s
                LOCATION: %s

                JOB DESCRIPTION (excerpt):
                %s

                CANDIDATE: %s
                SKILLS: %s
                SENIORITY: %s

                Return ONLY the letter body, no preamble or subject line.
                """.formatted(
                nullSafe(job.getTitle()),
                nullSafe(job.getCompany()),
                nullSafe(job.getLocation()),
                descExcerpt,
                nullSafe(profile.getFullName()),
                skills,
                nullSafe(profile.getSeniority()));
    }

    static String excerpt(String s, int max) {
        if (s == null) return "";
        String t = s.strip();
        return t.length() <= max ? t : t.substring(0, max) + "...";
    }

    static String nullSafe(String s) {
        return s == null ? "" : s;
    }
}
