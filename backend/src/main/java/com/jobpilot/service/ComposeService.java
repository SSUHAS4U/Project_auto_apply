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
            You are an expert job-application writer. Produce a cold email AND a cover letter tailored
            to THIS company/role, grounded ONLY in the candidate profile + job details.

            FOLLOW THE CANDIDATE'S SAVED TEMPLATES for structure, layout, tone and section order.
            Fill EVERY [placeholder] with real profile data — never leave a bracket. If a template line
            has no matching data, drop that line. Keep the template's headings/letterhead if it has them.

            - subject     — a crisp subject line (role + company + candidate name).
            - coldEmail   — the email, following the EMAIL TEMPLATE (130-180 words). Mention the resume is attached.
            - coverLetter — the full cover letter, following the COVER LETTER TEMPLATE, grounded in the JOB DETAILS:
                            name concrete responsibilities and tie them to the candidate's real strengths.

            HARD RULES:
            - Use ONLY facts from the profile/templates. NEVER invent years of experience, employers, titles,
              or technologies. If early-career, be honest and lead with projects/skills + eagerness.
            - BANNED filler (never use): "highly motivated", "detail-oriented", "quick learner",
              "strong work ethic", "passion for technology", "thrive in", "fast-paced environment",
              "team player", "make me an ideal fit".
            - Be specific to the company/role — never generic. No leftover [brackets].

            Output EXACTLY in this format — use the delimiter lines verbatim, NO JSON, NO markdown:
            @@SUBJECT@@
            <subject line>
            @@EMAIL@@
            <cold email body>
            @@COVER@@
            <cover letter body>""";

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
        Map<String, String> parsed = parseSections(raw);
        String subject = parsed.get("subject");
        String cover = parsed.get("cover");
        String cold = parsed.get("email");
        if (subject == null || subject.isBlank()) {
            subject = "Application for " + nz(role) + (notBlank(company) ? " - " + company : "")
                    + " | " + nz(p.getFullName());
        }
        return Map.of("subject", subject, "coverLetter", nz(cover), "coldEmail", nz(cold));
    }

    /** Parse the @@SUBJECT@@/@@EMAIL@@/@@COVER@@ format, falling back to JSON, then raw. */
    private Map<String, String> parseSections(String raw) {
        Map<String, String> out = new java.util.HashMap<>();
        if (raw == null) raw = "";
        if (raw.contains("@@EMAIL@@") || raw.contains("@@COVER@@")) {
            out.put("subject", between(raw, "@@SUBJECT@@", "@@EMAIL@@"));
            out.put("email", between(raw, "@@EMAIL@@", "@@COVER@@"));
            out.put("cover", between(raw, "@@COVER@@", null));
            return out;
        }
        // Fallback: the model emitted JSON after all.
        JsonNode json = parseJson(raw);
        if (json != null && (json.has("coverLetter") || json.has("coldEmail"))) {
            out.put("subject", json.path("subject").asText(""));
            out.put("email", json.path("coldEmail").asText(""));
            out.put("cover", json.path("coverLetter").asText(""));
            return out;
        }
        // Last resort: put everything in the cover box so nothing is lost.
        out.put("subject", "");
        out.put("email", "");
        out.put("cover", raw.strip());
        return out;
    }

    private static String between(String s, String start, String end) {
        int i = s.indexOf(start);
        if (i < 0) return "";
        i += start.length();
        int j = end == null ? s.length() : s.indexOf(end, i);
        if (j < 0) j = s.length();
        return s.substring(i, j).strip();
    }

    /** Build a cover-letter PDF for download/preview in the composer. */
    public byte[] coverPdf(String coverLetter) {
        if (coverLetter == null || coverLetter.isBlank()) throw new IllegalArgumentException("cover letter is empty");
        return PdfUtil.textToPdf(coverDocument(profileService.get(), coverLetter.strip()));
    }

    /** AI-refine the email and/or cover letter per a free-form instruction (composer chat). */
    public Map<String, String> refine(String coldEmail, String coverLetter, String instruction) {
        if (instruction == null || instruction.isBlank()) throw new IllegalArgumentException("instruction is required");
        if (!ai.isEnabled()) throw new IllegalStateException("AI is not configured.");
        String sys = """
                You are editing a job application. Apply the user's instruction to the EMAIL and/or COVER
                LETTER below. Change only what the instruction asks; keep everything else intact.
                The candidate's full PROFILE is provided. When the instruction asks to add or mention
                something (internships, projects, skills, education, certifications…):
                1. FIRST look it up in the PROFILE and use the real details (names, dates, tech).
                2. If the profile has nothing relevant, write a natural role-appropriate line WITHOUT
                   inventing specifics — no made-up company names, dates, metrics or credentials.
                Keep facts truthful and never output [bracket placeholders].
                Return EXACTLY this format, verbatim delimiters, no markdown:
                @@EMAIL@@
                <updated email — unchanged if the instruction doesn't touch it>
                @@COVER@@
                <updated cover letter — unchanged if the instruction doesn't touch it>""";
        String user = "PROFILE:\n" + profileFacts(profileService.get())
                + "\n\nEMAIL:\n" + nz(coldEmail) + "\n\nCOVER LETTER:\n" + nz(coverLetter)
                + "\n\nINSTRUCTION: " + instruction.strip();
        String raw = ai.complete(sys, user, false, true);
        String email = between(raw, "@@EMAIL@@", "@@COVER@@");
        String cover = between(raw, "@@COVER@@", null);
        return Map.of(
                "coldEmail", email.isBlank() ? nz(coldEmail) : email,
                "coverLetter", cover.isBlank() ? nz(coverLetter) : cover);
    }

    /** The whole profile as compact plain text, so edit instructions can pull real details. */
    private static String profileFacts(Profile p) {
        if (p == null) return "(empty profile)";
        StringBuilder sb = new StringBuilder();
        add(sb, "Name", p.getFullName());
        add(sb, "Headline", p.getHeadline());
        add(sb, "Current role", nz(p.getCurrentTitle())
                + (notBlank(p.getCurrentCompany()) ? " at " + p.getCurrentCompany() : ""));
        add(sb, "Experience (years)", p.getYearsExperience());
        add(sb, "Location", p.getLocation());
        add(sb, "Skills", p.getSkills() == null ? null : String.join(", ", p.getSkills()));
        add(sb, "Summary", p.getSummary());
        if (p.getExperience() != null) {
            for (var e : p.getExperience()) {
                add(sb, "Experience entry", entry(e, "title", "role") + " at " + entry(e, "company")
                        + " (" + entry(e, "start") + " - " + entry(e, "end") + "): " + entry(e, "description"));
            }
        }
        if (p.getEducation() != null) {
            for (var e : p.getEducation()) {
                add(sb, "Education", entry(e, "degree") + " " + entry(e, "field") + ", "
                        + entry(e, "school") + " (" + entry(e, "year") + ")");
            }
        }
        if (p.getCertifications() != null) {
            for (var c : p.getCertifications()) {
                add(sb, "Certification", entry(c, "name", "title") + " " + entry(c, "issuer") + " " + entry(c, "year"));
            }
        }
        return sb.length() == 0 ? "(empty profile)" : sb.toString();
    }

    private static void add(StringBuilder sb, String label, String value) {
        if (value != null && !value.isBlank() && !value.strip().matches("[-–—,():]*")) {
            sb.append(label).append(": ").append(value.strip().replaceAll("\\s+", " ")).append('\n');
        }
    }

    private static String entry(Map<String, Object> m, String... keys) {
        for (String k : keys) {
            Object v = m.get(k);
            if (v instanceof String s && !s.isBlank()) return s.strip();
        }
        return "";
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

        // The email body is the cold email; the cover letter rides along as a PDF attachment
        // (not pasted into the body), next to the resume PDF — like a real application.
        String email = coldEmail == null ? "" : coldEmail.strip();
        String cover = coverLetter == null ? "" : coverLetter.strip();
        StringBuilder body = new StringBuilder();
        if (!email.isBlank()) body.append(email);
        else body.append("Dear Hiring Team,\n\nPlease find my cover letter and resume attached for your consideration. "
                + "I'd welcome the chance to discuss how I can contribute.");
        body.append("\n\n").append(nz(p.getFullName()));
        if (notBlank(p.getEmail())) body.append("\n").append(p.getEmail());
        if (notBlank(p.getPhone())) body.append("\n").append(p.getPhone());

        String subj = (subject == null || subject.isBlank())
                ? "Application — " + nz(p.getFullName()) : subject;

        java.util.List<MailAttachment> attachments = new java.util.ArrayList<>();
        boolean coverAttached = false;
        if (!cover.isBlank()) {
            attachments.add(new MailAttachment("CoverLetter_" + safeName(p.getFullName()) + ".pdf",
                    PdfUtil.textToPdf(coverDocument(p, cover))));
            coverAttached = true;
        }
        byte[] resumeBytes = p.getResumeData();
        boolean hasResume = attachResume && resumeBytes != null && resumeBytes.length > 0;
        if (hasResume) {
            attachments.add(new MailAttachment(
                    p.getResumeFilename() == null ? "resume.pdf" : p.getResumeFilename(), resumeBytes));
        }

        String bcc = p.getEmail(); // keep a copy in the sender's own inbox
        mail.sendWithAttachments(to, subj, body.toString(), attachments, bcc);
        incrementMail();
        return Map.of("sentTo", to, "subject", subj, "resumeAttached", hasResume, "coverLetterAttached", coverAttached);
    }

    /** Build a printable cover-letter document for the PDF. If the letter already carries its own
     *  letterhead (template starts with the candidate's name), use it as-is; else prepend one. */
    private String coverDocument(Profile p, String cover) {
        String body = cover.replace("[Your Name]", nz(p.getFullName())).replace("[Name]", nz(p.getFullName()));
        String name = nz(p.getFullName()).trim();
        boolean hasLetterhead = !name.isBlank() && body.stripLeading().regionMatches(true, 0, name, 0, name.length());
        if (hasLetterhead) return body;
        StringBuilder sb = new StringBuilder();
        sb.append(name).append("\n");
        String contact = (notBlank(p.getEmail()) ? p.getEmail() : "")
                + (notBlank(p.getPhone()) ? (notBlank(p.getEmail()) ? "  |  " : "") + p.getPhone() : "");
        if (!contact.isBlank()) sb.append(contact).append("\n");
        sb.append(LocalDate.now(ZoneOffset.UTC)).append("\n\n");
        sb.append(body);
        return sb.toString();
    }

    private static String safeName(String s) {
        String n = (s == null ? "JobPilot" : s).replaceAll("[^A-Za-z0-9]", "");
        return n.isBlank() ? "JobPilot" : n;
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
