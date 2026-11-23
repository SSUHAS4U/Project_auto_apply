package com.jobpilot.service.mail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.ai.AiService;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import com.jobpilot.domain.SentMessage;
import com.jobpilot.service.documents.ResumeDocService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.jobpilot.service.documents.PdfUtil;
import com.jobpilot.service.ops.SettingsService;
import com.jobpilot.service.profile.ProfileService;

/**
 * Manual outreach composer: turn free-form job details into a cover letter +
 * cold email, then send to a chosen recipient with the resume attached.
 * AI-gated by the daily cap; sends gated by the mail daily limit.
 */
@Service
public class ComposeService {

    private static final Logger log = LoggerFactory.getLogger(ComposeService.class);

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
            - SIGNATURE: end the cold email with EXACTLY ONE signature block — name, phone, email,
              then each link LABELED on its own line:
                LinkedIn: <url>
                GitHub: <url>
                Portfolio: <url>
              Never paste bare URLs strung together with "|", and never write a second signature.

            - whatsapp    — a SHORT WhatsApp message to the recruiter (45-75 words, 3-5 short lines):
                            a greeting, who the candidate is in one line, the role + company, ONE concrete
                            strength tied to the job, and a polite ask to review the résumé. Sign off with the
                            name only. NO links, NO signature block (the résumé and cover-letter links are
                            appended automatically), no markdown, at most one emoji (prefer none).

            Output EXACTLY in this format — use the delimiter lines verbatim, NO JSON, NO markdown:
            @@SUBJECT@@
            <subject line>
            @@EMAIL@@
            <cold email body>
            @@COVER@@
            <cover letter body>
            @@WHATSAPP@@
            <whatsapp message>""";

    private final AiService ai;
    private final ProfileService profileService;
    private final MailService mail;
    private final SettingsService settings;
    private final JobPilotProperties props;
    private final ResumeDocService resumes;
    private final SentMessageService history;
    private final ShareLinkService links;
    private final ObjectMapper mapper = new ObjectMapper();

    public ComposeService(AiService ai, ProfileService profileService,
                          MailService mail, SettingsService settings, JobPilotProperties props,
                          ResumeDocService resumes, SentMessageService history, ShareLinkService links) {
        this.ai = ai;
        this.profileService = profileService;
        this.mail = mail;
        this.settings = settings;
        this.props = props;
        this.resumes = resumes;
        this.history = history;
        this.links = links;
    }

    // ---- read a pasted job post ------------------------------------------------------------

    private static final String EXTRACT_SYSTEM = """
            You read a job post that a candidate pasted and pull out what they need to apply.
            Return ONLY a JSON object, no markdown, with these string keys (use "" when absent):
              role     — the job title being hired for, as a short title ("Java Developer").
              company  — the HIRING company's name as written in the post (not a job board).
              email    — the address applications should be SENT to, copied exactly from the post.
              phone    — the number to contact on WhatsApp/phone, copied exactly from the post.
              subject  — ONLY if the post explicitly tells applicants what subject line to use,
                         copy that subject exactly; otherwise "". Never write one yourself.
            Never invent anything: every value must come from the post.""";

    /**
     * What Compose can fill from a pasted post: role, company, recipient email, a requested
     * subject, a phone number. Rules run first ({@link ComposeExtractor}); the AI, when on, picks
     * among them and adds role/company — but an AI email, phone or subject is accepted only if it
     * is literally in the post, and a company only if it is in the post or the email's domain.
     */
    public Map<String, Object> extract(String text) {
        String post = text == null ? "" : text.strip();
        if (post.length() > 20_000) post = post.substring(0, 20_000);
        List<String> emails = ComposeExtractor.emails(post);
        List<String> phones = ComposeExtractor.phones(post);
        String subject = ComposeExtractor.subject(post);
        String role = ComposeExtractor.role(post);
        String company = ComposeExtractor.company(post);
        String email = emails.isEmpty() ? null : emails.get(0);
        String phone = phones.isEmpty() ? null : phones.get(0);
        String source = "rules";

        if (!post.isEmpty() && ai.isEnabled()) {
            try {
                String raw = ai.complete(EXTRACT_SYSTEM, "JOB POST:\n" + clip(post, 12_000), true, true, 400);
                JsonNode j = parseJson(raw);
                if (j != null) {
                    source = "ai";
                    String aiEmail = j.path("email").asText("").strip();
                    for (String e : emails) if (e.equalsIgnoreCase(aiEmail)) email = e;
                    String aiPhone = j.path("phone").asText("").replaceAll("\\D", "");
                    if (aiPhone.length() >= 8) {
                        for (String p : phones) if (p.replaceAll("\\D", "").endsWith(aiPhone) || aiPhone.endsWith(p.replaceAll("\\D", ""))) phone = p;
                    }
                    String aiSubject = j.path("subject").asText("").strip();
                    if (subject == null && aiSubject.length() >= 3 && ComposeExtractor.appearsIn(aiSubject, post)) subject = aiSubject;
                    String aiRole = oneLine(j.path("role").asText(""));
                    if (aiRole != null) role = aiRole;
                    String aiCompany = oneLine(j.path("company").asText(""));
                    String stem = ComposeExtractor.domainStem(email);
                    if (aiCompany != null && (ComposeExtractor.appearsIn(aiCompany, post)
                            || (stem != null && aiCompany.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "").contains(stem)))) {
                        company = aiCompany;
                    }
                }
            } catch (RuntimeException e) {
                // The rules' answer still stands; the AI only refines it.
                log.warn("compose extract: AI step failed, using the rules only: {}", e.getMessage());
            }
        }

        Profile p = profileService.get();
        boolean requested = subject != null;
        if (requested) subject = ComposeExtractor.fillPlaceholders(subject, p.getFullName(), role, company);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("role", nz(role));
        out.put("company", nz(company));
        out.put("email", nz(email));
        out.put("emails", emails);
        out.put("phone", nz(phone));
        out.put("phones", phones);
        out.put("subject", nz(subject));
        out.put("subjectRequested", requested);
        out.put("source", source);
        return out;
    }

    private static String oneLine(String s) {
        if (s == null) return null;
        String t = s.strip();
        if (t.isEmpty() || t.contains("\n") || t.length() > 120) return null;
        return t;
    }

    private static String clip(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
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
        String whatsapp = parsed.get("whatsapp");
        if (subject == null || subject.isBlank()) {
            subject = "Application for " + nz(role) + (notBlank(company) ? " - " + company : "")
                    + " | " + nz(p.getFullName());
        }
        if (whatsapp == null || whatsapp.isBlank()) whatsapp = defaultWhatsapp(p, role, company);
        return Map.of("subject", subject, "coverLetter", nz(cover), "coldEmail", nz(cold), "whatsapp", whatsapp);
    }

    /** The WhatsApp message when the model didn't write one — short, true, and complete. */
    static String defaultWhatsapp(Profile p, String role, String company) {
        String name = nz(p.getFullName()).strip();
        String who = notBlank(p.getHeadline()) ? p.getHeadline().strip()
                : notBlank(p.getCurrentTitle()) ? p.getCurrentTitle().strip() : "";
        StringBuilder sb = new StringBuilder("Hello,\n\n");
        sb.append(name.isEmpty() ? "I" : "I'm " + name).append(who.isEmpty() ? "" : ", " + who).append(".\n");
        sb.append("I'd like to apply for the ").append(notBlank(role) ? role.strip() : "open").append(" role")
                .append(notBlank(company) ? " at " + company.strip() : "").append(".\n");
        sb.append("Please find my résumé and cover letter below — I'd be glad to talk.\n\nThank you");
        if (!name.isEmpty()) sb.append(",\n").append(name);
        return sb.toString();
    }

    /** Parse the @@SUBJECT@@/@@EMAIL@@/@@COVER@@ format, falling back to JSON, then raw. */
    private Map<String, String> parseSections(String raw) {
        Map<String, String> out = new java.util.HashMap<>();
        if (raw == null) raw = "";
        if (raw.contains("@@EMAIL@@") || raw.contains("@@COVER@@")) {
            out.put("subject", between(raw, "@@SUBJECT@@", "@@EMAIL@@"));
            out.put("email", between(raw, "@@EMAIL@@", "@@COVER@@"));
            // between() runs to the end when the end marker is missing, so a reply without a
            // WhatsApp section still yields the whole cover letter.
            out.put("cover", between(raw, "@@COVER@@", "@@WHATSAPP@@"));
            out.put("whatsapp", between(raw, "@@WHATSAPP@@", null));
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
        return send(to, subject, coldEmail, coverLetter, attachResume, null, null, null);
    }

    /**
     * Send the composed email. {@code resumeId} picks a résumé from the library; null attaches
     * the profile's default. {@code company}/{@code role} are for the History page only.
     * Every attempt that reaches the mail server is recorded — a failure too, with its reason.
     */
    public Map<String, Object> send(String to, String subject, String coldEmail,
                                    String coverLetter, boolean attachResume,
                                    UUID resumeId, String company, String role) {
        if (to == null || to.isBlank()) throw new IllegalArgumentException("recipient email required");
        String recipient = to.strip();
        if (!recipient.matches("[^\\s@,;<>]+@[^\\s@,;<>]+\\.[A-Za-z]{2,}")) {
            throw new IllegalArgumentException("\"" + recipient + "\" isn't an email address — check the Recipient field.");
        }
        to = recipient;
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
        // Append a fallback signature ONLY when the email doesn't already sign off with
        // the candidate's details — the AI usually writes a full signature block, and
        // appending unconditionally duplicated name/email/phone at the bottom.
        String tail = email.length() > 400 ? email.substring(email.length() - 400) : email;
        String tailLow = tail.toLowerCase(java.util.Locale.ROOT);
        boolean signed =
                (notBlank(p.getFullName()) && tailLow.contains(p.getFullName().toLowerCase(java.util.Locale.ROOT)))
                || (notBlank(p.getEmail()) && tailLow.contains(p.getEmail().toLowerCase(java.util.Locale.ROOT)))
                || (notBlank(p.getPhone())
                        && tail.replaceAll("[\\s-]", "").contains(p.getPhone().replaceAll("[\\s-]", "")));
        if (!signed) {
            body.append("\n\n").append(nz(p.getFullName()));
            if (notBlank(p.getEmail())) body.append("\n").append(p.getEmail());
            if (notBlank(p.getPhone())) body.append("\n").append(p.getPhone());
        }

        String subj = (subject == null || subject.isBlank())
                ? "Application — " + nz(p.getFullName()) : subject;

        java.util.List<MailAttachment> attachments = new java.util.ArrayList<>();
        boolean coverAttached = false;
        if (!cover.isBlank()) {
            attachments.add(new MailAttachment("CoverLetter_" + safeName(p.getFullName()) + ".pdf",
                    PdfUtil.textToPdf(coverDocument(p, cover))));
            coverAttached = true;
        }
        boolean hasResume = false;
        String resumeName = null;
        if (attachResume && resumeId != null) {
            // The résumé the user picked. Fails BEFORE sending, naming it, if it has no file —
            // sending without the résumé they chose would be worse than not sending.
            ResumeDocService.ResumeFile f = resumes.file(resumeId);
            attachments.add(new MailAttachment(f.filename(), f.data()));
            hasResume = true;
            resumeName = resumes.get(resumeId).getName();
        } else if (attachResume) {
            byte[] resumeBytes = p.getResumeData();
            if (resumeBytes != null && resumeBytes.length > 0) {
                resumeName = p.getResumeFilename() == null ? "resume.pdf" : p.getResumeFilename();
                attachments.add(new MailAttachment(resumeName, resumeBytes));
                hasResume = true;
            }
        }

        SentMessage rec = new SentMessage();
        rec.setChannel(SentMessage.EMAIL);
        rec.setCompany(company);
        rec.setRoleTitle(role);
        rec.setRecipient(to);
        rec.setSubject(subj);
        rec.setBody(body.toString());
        rec.setCoverLetter(cover.isBlank() ? null : cover);
        rec.setCoverAttached(coverAttached);
        rec.setResumeAttached(hasResume);
        rec.setResumeName(resumeName);

        String bcc = p.getEmail(); // keep a copy in the sender's own inbox
        try {
            mail.sendWithAttachments(to, subj, body.toString(), attachments, bcc);
        } catch (RuntimeException e) {
            rec.setStatus(SentMessage.FAILED);
            rec.setError(e.getMessage());
            history.record(rec);
            throw e;
        }
        incrementMail();
        rec.setStatus(SentMessage.SENT);
        history.record(rec);
        return Map.of("sentTo", to, "subject", subj, "resumeAttached", hasResume, "coverLetterAttached", coverAttached,
                "resumeName", nz(resumeName));
    }

    // ---- WhatsApp ----------------------------------------------------------------------------

    /**
     * Prepare a WhatsApp message: the text plus links to the chosen résumé and the cover letter,
     * and the click-to-chat URL that opens it in WhatsApp addressed to {@code phone}.
     *
     * The user presses Send inside WhatsApp — JobPilot cannot and does not send on their behalf
     * this way — so History records it as OPENED, never as SENT.
     *
     * @param baseUrl where a recipient reaches this API, for the links (configured or derived)
     */
    public Map<String, Object> whatsapp(String phone, String message, String company, String role,
                                        UUID resumeId, boolean includeResume, String coverLetter,
                                        String baseUrl) {
        Profile p = profileService.get();
        String cc = notBlank(p.getPhoneCountryCode()) ? p.getPhoneCountryCode() : "91";
        String number = ComposeExtractor.normalizePhone(phone, cc);
        if (number == null) {
            throw new IllegalArgumentException("\"" + nz(phone).strip() + "\" isn't a phone number WhatsApp can open — "
                    + "use the full number with country code, e.g. +91 98765 43210.");
        }
        String text = message == null ? "" : message.strip();
        if (text.isEmpty()) throw new IllegalArgumentException("Write the WhatsApp message first (Generate fills it in).");

        StringBuilder full = new StringBuilder(text);
        String resumeName = null;
        boolean resumeLinked = false;
        boolean coverLinked = false;
        String base = baseUrl == null ? "" : baseUrl.replaceAll("/+$", "");
        if (includeResume) {
            if (resumeId == null) {
                throw new IllegalArgumentException("Choose which résumé to link — pick one under \"Résumé to send\".");
            }
            String token = links.shareResume(resumeId);
            resumeName = resumes.get(resumeId).getName();
            full.append("\n\nRésumé: ").append(base).append("/api/public/doc/").append(token);
            resumeLinked = true;
        }
        if (coverLetter != null && !coverLetter.isBlank()) {
            String token = links.shareCover(coverLetter);
            full.append(resumeLinked ? "\n" : "\n\n").append("Cover letter: ").append(base).append("/api/public/doc/").append(token);
            coverLinked = true;
        }
        String finalText = full.toString();
        String url = "https://wa.me/" + number + "?text="
                + java.net.URLEncoder.encode(finalText, java.nio.charset.StandardCharsets.UTF_8).replace("+", "%20");

        SentMessage rec = new SentMessage();
        rec.setChannel(SentMessage.WHATSAPP);
        rec.setStatus(SentMessage.OPENED);
        rec.setCompany(company);
        rec.setRoleTitle(role);
        rec.setRecipient("+" + number);
        rec.setBody(finalText);
        rec.setCoverLetter(coverLinked ? coverLetter.strip() : null);
        rec.setCoverAttached(coverLinked);
        rec.setResumeAttached(resumeLinked);
        rec.setResumeName(resumeName);
        history.record(rec);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("url", url);
        out.put("phone", "+" + number);
        out.put("text", finalText);
        return out;
    }

    /** Build a printable cover-letter document for the PDF. If the letter already carries its own
     *  letterhead (template starts with the candidate's name), use it as-is; else prepend one. */
    static String coverDocument(Profile p, String cover) {
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

    static String safeName(String s) {
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
