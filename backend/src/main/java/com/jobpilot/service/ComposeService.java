package com.jobpilot.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.ai.AiService;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
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
            You are an expert job-application writer. Given a candidate profile and a job
            description, produce TWO things:
              1. coverLetter — 150-220 words, professional first person, specific to the role.
              2. coldEmail — a short (90-140 word) outreach email to a recruiter/hiring manager,
                 warm and direct, referencing the role and 1-2 concrete strengths.
            Use only facts implied by the candidate. No placeholders. Sign with the real name.
            Respond with STRICT JSON only: {"coverLetter": "...", "coldEmail": "..."}""";

    private final AiService ai;
    private final ProfileService profileService;
    private final ResumeStorageService resume;
    private final MailService mail;
    private final SettingsService settings;
    private final JobPilotProperties props;
    private final ObjectMapper mapper = new ObjectMapper();

    public ComposeService(AiService ai, ProfileService profileService, ResumeStorageService resume,
                          MailService mail, SettingsService settings, JobPilotProperties props) {
        this.ai = ai;
        this.profileService = profileService;
        this.resume = resume;
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
        String user = """
                CANDIDATE: %s
                HEADLINE: %s
                SKILLS: %s
                EXPERIENCE (yrs): %s
                SUMMARY: %s

                ROLE: %s
                COMPANY: %s
                JOB DETAILS:
                %s
                """.formatted(
                nz(p.getFullName()), nz(p.getHeadline()),
                p.getSkills() == null ? "" : String.join(", ", p.getSkills()),
                nz(p.getYearsExperience()), nz(p.getSummary()),
                nz(role), nz(company), nz(jobDetails));

        String raw = ai.complete(SYSTEM, user, false);
        JsonNode json = parseJson(raw);
        String cover = json != null ? json.path("coverLetter").asText("") : "";
        String cold = json != null ? json.path("coldEmail").asText("") : "";
        if (cover.isBlank() && cold.isBlank()) {
            // Model didn't return JSON — surface its text as the cover letter.
            cover = raw;
        }
        return Map.of("coverLetter", cover, "coldEmail", cold);
    }

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

        if (attachResume && resume.exists(p.getResumePath())) {
            Path att = resume.resolve(p.getResumePath());
            String name = p.getResumeFilename() == null ? "resume.pdf" : p.getResumeFilename();
            mail.sendWithAttachment(to, subj, body.toString(), att, name);
        } else {
            mail.sendWithAttachment(to, subj, body.toString(), null, null);
        }
        incrementMail();
        return Map.of("sentTo", to, "subject", subj, "resumeAttached",
                attachResume && resume.exists(p.getResumePath()));
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
