package com.jobpilot.service.cover;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;

/** Shared prompt + text helpers for LLM providers. */
final class CoverLetterPrompt {

    private CoverLetterPrompt() {}

    static String build(Job job, Profile profile, String description) {
        String skills = profile.getSkills() == null ? "" : String.join(", ", profile.getSkills());
        String descExcerpt = excerpt(description, 2200);
        String summary = excerpt(profile.getSummary(), 400);
        return """
                Write a cover letter for THIS specific role. It must read differently from a generic
                template — ground every claim in the actual job description below.

                ROLE: %s
                COMPANY: %s
                LOCATION: %s

                JOB DESCRIPTION:
                %s

                === THE ONLY FACTS YOU MAY USE ABOUT THE CANDIDATE ===
                NAME: %s
                EXPERIENCE: %s
                HEADLINE: %s
                SUMMARY: %s
                SKILLS (the ONLY technologies you may claim): %s
                SENIORITY: %s
                =====================================================

                Do not state any number of years, employer, title, or technology not listed above.
                Return ONLY the letter body (no subject line, no "Dear...", no sign-off block beyond the name).
                """.formatted(
                nullSafe(job.getTitle()),
                nullSafe(job.getCompany()),
                nullSafe(job.getLocation()),
                descExcerpt.isBlank() ? "(not available — infer what this role needs from its title)" : descExcerpt,
                nullSafe(profile.getFullName()),
                experience(profile),
                nullSafe(profile.getHeadline()),
                summary,
                skills,
                nullSafe(profile.getSeniority()));
    }

    /** A factual, hard-to-misread experience line so the model can't invent tenure. */
    private static String experience(Profile p) {
        String years = p.getYearsExperience();
        String yearsPart = (years == null || years.isBlank() || years.equals("0"))
                ? "early-career / fresher (no full-time years yet)"
                : years + " year(s) of experience";
        String role = p.getCurrentTitle();
        String company = p.getCurrentCompany();
        if (role != null && !role.isBlank()) {
            yearsPart += " — currently " + role + (company != null && !company.isBlank() ? " at " + company : "");
        }
        return yearsPart;
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
