package com.jobpilot.service.cover;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import org.springframework.stereotype.Component;

/** Deterministic mail-merge fallback; always available, no LLM required. */
@Component
public class TemplateCoverLetterProvider implements CoverLetterProvider {

    @Override
    public String name() {
        return "template";
    }

    @Override
    public String generate(Job job, Profile profile) {
        String name = CoverLetterPrompt.nullSafe(profile.getFullName());
        String role = CoverLetterPrompt.nullSafe(job.getTitle());
        String company = job.getCompany() == null || job.getCompany().isBlank()
                ? "your team" : job.getCompany();
        String skills = (profile.getSkills() == null || profile.getSkills().isEmpty())
                ? "my relevant experience"
                : String.join(", ", profile.getSkills().subList(0, Math.min(6, profile.getSkills().size())));

        return """
                Dear Hiring Team,

                I am writing to express my strong interest in the %s position at %s. The role
                aligns closely with my background, and I am confident I can contribute from day one.

                My core strengths include %s. I enjoy building reliable, well-tested software and
                collaborating across a team to ship features that matter. I am drawn to %s for the
                opportunity to take on meaningful technical challenges and keep growing.

                I have attached my resume for your review and would welcome the chance to discuss how
                my skills fit your needs. Thank you for your time and consideration.

                Best regards,
                %s""".formatted(role, company, skills, company, name);
    }
}
