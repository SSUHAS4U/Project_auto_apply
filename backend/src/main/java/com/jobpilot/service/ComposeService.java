package com.jobpilot.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.ai.AiService;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Map;

/**
 * Manual outreach composer: turn free-form job details into a cover letter +
 * cold email, then send to a chosen recipient with the resume attached.
 * AI-gated by the daily cap; sends gated by the mail daily limit.
 */
@Service
public class ComposeService {

    private static final String SYSTEM = """
            You are an expert job-application writer. Given a candidate profile, the candidate's
            preferred TEMPLATES, and a target job, produce three things tailored to THIS company/role:
              1. subject     — a crisp email subject line based on the role + company + candidate
                               (e.g. "Application for Software Engineer Role - Suhas S | CSE 2026 | Nokia Intern").
              2. coldEmail   — rewrite the candidate's EMAIL TEMPLATE for this specific company and role,
                               keeping its structure, bullet snapshot, and signature; fill [Company Name]/
                               [Recruiter Name] (use "Hiring Team" if unknown). Keep all real facts.
              3. coverLetter — rewrite the candidate's COVER LETTER TEMPLATE for this company/role,
                               keeping structure and real facts; fill placeholders.
            Use ONLY facts from the profile/templates. Never invent experience. No leftover [brackets]
            except a name you genuinely cannot know. Respond with STRICT JSON only:
            {"subject": "...", "coldEmail": "...", "coverLetter": "..."}""";

    private final AiService ai;
    private final ProfileService profileService;
    private final MailService mail;
    private final SettingsService settings;
    private final JobPilotProperties props;
    private final ObjectMapper mapper = new ObjectMapper();

    public ComposeService(AiService ai, ProfileService profileService,
                          MailService mail, SettingsService settings, JobPilotProperties props) {
        this.ai = ai;
        this.profileService = profileService;
        this.mail = mail;
        this.settings = settings;
        this.props = props;
    }

    public Map<String, String> generate(String role, String company, String jobDetails) {
        Profile p = profileService.get();
        if (!ai.isEnabled()) {
            throw new IllegalStateException("AI is not configured. Set JOBPILOT_AI_PROVIDER + key, "
                    + "or use the Email-apply flow which has a template fallback.");
        }
        String contact = nz(p.getFullName())
                + (notBlank(p.getPhone()) ? " | " + p.getPhone() : "")
                + (notBlank(p.getEmail()) ? " | " + p.getEmail() : "");
        String links = p.getLinks() == null ? "" : p.getLinks().entrySet().stream()
                .filter(e -> e.getValue() != null && !e.getValue().isBlank())
                .map(e -> e.getKey() + ": " + e.getValue()).reduce((a, b) -> a + ", " + b).orElse("");

        String user = """
                CANDIDATE: %s
                CONTACT: %s
                LINKS: %s
                HEADLINE: %s
                SKILLS: %s
                EXPERIENCE: %s
                SUMMARY: %s

                EMAIL TEMPLATE (rewrite this for the company/role):
                %s

                COVER LETTER TEMPLATE (rewrite this for the company/role):
                %s

                TARGET ROLE: %s
                TARGET COMPANY: %s
                JOB DETAILS:
                %s
                """.formatted(
                nz(p.getFullName()), contact, links, nz(p.getHeadline()),
                p.getSkills() == null ? "" : String.join(", ", p.getSkills()),
                nz(p.getYearsExperience()), nz(p.getSummary()),
                templateOrDefault(p.getEmailTemplate(), DEFAULT_EMAIL),
                templateOrDefault(p.getCoverLetterTemplate(), DEFAULT_COVER),
                nz(role), nz(company), nz(jobDetails));

        String raw = ai.complete(SYSTEM, user, false, true);
        JsonNode json = parseJson(raw);
        String subject = json != null ? json.path("subject").asText("") : "";
        String cover = json != null ? json.path("coverLetter").asText("") : "";
        String cold = json != null ? json.path("coldEmail").asText("") : "";
        if (cover.isBlank() && cold.isBlank()) cover = raw;
        if (subject.isBlank()) {
            subject = "Application for " + nz(role) + (notBlank(company) ? " - " + company : "")
                    + " | " + nz(p.getFullName());
        }
        return Map.of("subject", subject, "coverLetter", cover, "coldEmail", cold);
    }

    private String templateOrDefault(String t, String def) {
        return (t == null || t.isBlank()) ? def : t;
    }

    private static final String DEFAULT_EMAIL = """
            Subject: Application for [Role] - [Your Name]

            Hi [Recruiter Name],
            I came across the [Role] opening at [Company Name] and would like to express my interest.
            Based on the requirements, I believe my background aligns well with what your team needs.
            A quick snapshot of my profile:
            - <key education / current role>
            - <relevant internship / experience>
            - <notable projects>
            - <core skills>
            - <certifications>
            I've attached my resume and would welcome the chance to discuss how I can contribute.
            Best regards,
            [Your Name]""";

    private static final String DEFAULT_COVER = """
            Dear Hiring Manager,
            I am writing to express my interest in the [Role] position at [Company Name].
            <2-3 paragraphs tying the candidate's education, internship, projects, and skills to the role>
            I would welcome the opportunity to discuss my qualifications further. Thank you for your
            time and consideration.
            Sincerely,
            [Your Name]""";

    public Map<String, Object> send(String to, String subject, String coldEmail,
                                    String coverLetter, boolean attachResume) {
        if (to == null || to.isBlank()) throw new IllegalArgumentException("recipient email required");
        enforceMailLimit();
        Profile p = profileService.get();

        StringBuilder body = new StringBuilder();
        body.append(coldEmail == null ? "" : coldEmail.strip());
        if (coverLetter != null && !coverLetter.isBlank()) {
            body.append("\n\n---\n\n").append(coverLetter.strip());
        }
        body.append("\n\n").append(nz(p.getFullName()));
        if (notBlank(p.getEmail())) body.append("\n").append(p.getEmail());
        if (notBlank(p.getPhone())) body.append("\n").append(p.getPhone());

        String subj = (subject == null || subject.isBlank())
                ? "Application — " + nz(p.getFullName()) : subject;

        byte[] resumeBytes = p.getResumeData();
        boolean hasResume = attachResume && resumeBytes != null && resumeBytes.length > 0;
        if (hasResume) {
            String name = p.getResumeFilename() == null ? "resume.pdf" : p.getResumeFilename();
            mail.sendWithAttachmentBytes(to, subj, body.toString(), resumeBytes, name);
        } else {
            mail.sendWithAttachmentBytes(to, subj, body.toString(), null, null);
        }
        incrementMail();
        return Map.of("sentTo", to, "subject", subj, "resumeAttached", hasResume);
    }

    private void enforceMailLimit() {
        int used = mailUsedToday();
        if (used >= props.getMail().getDailyLimit()) {
            throw new IllegalStateException("Daily email limit reached (" + props.getMail().getDailyLimit() + ").");
        }
    }

    private int mailUsedToday() {
        return settings.get(mailKey()).map(Integer::parseInt).orElse(0);
    }

    private void incrementMail() {
        settings.put(mailKey(), String.valueOf(mailUsedToday() + 1));
    }

    private String mailKey() {
        return "mail_usage_" + LocalDate.now(ZoneOffset.UTC);
    }

    private JsonNode parseJson(String raw) {
        if (raw == null) return null;
        int start = raw.indexOf('{');
        int end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try {
            return mapper.readTree(raw.substring(start, end + 1));
        } catch (Exception e) {
            return null;
        }
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}
