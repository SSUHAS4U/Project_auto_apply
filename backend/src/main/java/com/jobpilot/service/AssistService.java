package com.jobpilot.service;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.domain.QaPair;
import com.jobpilot.repository.QaPairRepository;
import com.jobpilot.security.UserContext;
import com.jobpilot.service.ai.AiService;
import com.jobpilot.service.cover.CoverLetterService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Powers the extension's assisted-apply features: answering free-text application
 * questions with AI (grounded in the user's profile), a reusable Q&A bank, and
 * on-demand cover letters.
 */
@Service
public class AssistService {

    private static final String ANSWER_SYSTEM = """
            You are a career coach helping a candidate answer job-application questions in the
            BEST HONEST LIGHT. Write a confident first-person answer grounded in the candidate's
            background below.
            - For questions about a skill/tool the candidate may not have explicitly listed
              (e.g. "describe your exposure to PyTorch", "experience with Kubernetes"), do NOT
              say they have none. Give a constructive, basic-but-confident answer: connect their
              real foundation (programming, CS fundamentals, related tools) to the topic and show
              genuine eagerness and fast-learning. Claim FOUNDATIONAL / working familiarity — not
              deep expertise — so it stays believable.
            - Be specific, genuine and concise (2-5 sentences unless more is clearly needed).
            - MATCH THE ANSWER TO THE QUESTION TYPE — never write an essay where a value fits:
              * yes/no questions ("Are you willing to relocate?"): "Yes" or "No", plus at most one
                short supporting clause (and only if the field is a textarea).
              * link/URL fields: output ONLY the URL from the profile; if the profile has none,
                output an empty string.
              * numbers (salary, years, notice-period days, CGPA): the number alone, no sentences.
              * dates (DOB, available-from): the date alone in YYYY-MM-DD.
              * short factual fields (city, college, degree): the value alone.
              * "Answer field type" (when given) is the input control — a value-typed control
                (date/tel/url/email/number) must NEVER receive prose.
            - Don't fabricate specific employers, degrees, projects or year counts — keep it about
              capability and approach. No placeholders, no markdown, no preamble — output ONLY the answer.""";

    private final QaPairRepository qaRepo;
    private final ProfileService profiles;
    private final AiService ai;
    private final CoverLetterService coverLetters;

    public AssistService(QaPairRepository qaRepo, ProfileService profiles,
                         AiService ai, CoverLetterService coverLetters) {
        this.qaRepo = qaRepo;
        this.profiles = profiles;
        this.ai = ai;
        this.coverLetters = coverLetters;
    }

    /** Fields that want a FACT from the profile, not an essay: links, phone, DOB, CTC, … */
    private static final java.util.regex.Pattern FACTUAL_Q = java.util.regex.Pattern.compile(
            "linkedin|github|portfolio|website|profile (url|link)|\\burl\\b|\\blink\\b|leetcode|hackerrank|codechef"
                    + "|phone|mobile|contact number|whatsapp|e-?mail"
                    + "|date of birth|\\bdob\\b|birth ?date"
                    + "|notice period|current ctc|expected ctc|\\bctc\\b|current salary|expected salary|compensation"
                    + "|years? of experience|total experience|\\bpin ?code\\b|postal|zip"
                    + "|current (city|location)|\\bcity\\b|\\bgender\\b|nationality|\\bcollege\\b|university"
                    + "|graduation year|passing year|\\bcgpa\\b|\\bgpa\\b|percentage|roll (no|number)",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    public Map<String, Object> answer(String question) {
        return answer(question, null);
    }

    /**
     * Answer a question — saved bank first; then, for factual fields (links, phone, DOB…),
     * the literal profile value; otherwise a format-aware AI answer. {@code fieldType} is
     * the HTML control hint (date / tel / url / email / number / textarea / dropdown / text).
     */
    @Transactional
    public Map<String, Object> answer(String question, String fieldType) {
        if (question == null || question.isBlank()) {
            throw new IllegalArgumentException("question is required");
        }
        UUID userId = UserContext.require();
        String key = normalize(question);

        // 1. Exact key match in the bank.
        Optional<QaPair> exact = qaRepo.findByUserIdAndQuestionKey(userId, key);
        if (exact.isPresent()) {
            return Map.of("answer", exact.get().getAnswer(), "source", "saved");
        }
        // 2. Fuzzy match against the bank (token overlap) — reuse a similar answer.
        QaPair similar = bestMatch(qaRepo.findByUserIdOrderByUpdatedAtDesc(userId), key);
        if (similar != null) {
            return Map.of("answer", similar.getAnswer(), "source", "saved");
        }
        // 3. Factual field (or a value-typed control): the literal profile value, not prose.
        boolean typedFactual = fieldType != null
                && List.of("date", "tel", "url", "email", "number").contains(fieldType);
        if (typedFactual || FACTUAL_Q.matcher(question).find()) {
            String v = autofill(List.of(question.trim())).get(question.trim());
            if (v != null && !v.isBlank()) {
                if ("date".equals(fieldType)) v = toIsoDate(v);
                return Map.of("answer", v, "source", "profile");
            }
        }
        // 4. Generate with AI, grounded in the profile and shaped to the control type.
        //    Do NOT auto-save — only the user's explicit "Save" adds to the bank.
        Profile p = profiles.get();
        String prompt = "Candidate background:\n" + profileContext(p)
                + "\n\nApplication question: " + question.trim()
                + (fieldType == null || fieldType.isBlank() ? "" : "\nAnswer field type: " + fieldType)
                + "\n\nAnswer:";
        String generated = ai.complete(ANSWER_SYSTEM, prompt, false, false).trim();
        if ("date".equals(fieldType)) generated = toIsoDate(generated);
        return Map.of("answer", generated, "source", "ai");
    }

    /** Best-effort YYYY-MM-DD for <input type=date>; returns the input when unparseable. */
    private static String toIsoDate(String s) {
        if (s == null) return null;
        String t = s.trim();
        if (t.matches("\\d{4}-\\d{2}-\\d{2}")) return t;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})").matcher(t);   // dd/mm/yyyy (Indian forms)
        if (m.find()) {
            return "%s-%02d-%02d".formatted(m.group(3), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(1)));
        }
        try {
            var d = new java.text.SimpleDateFormat("dd MMMM yyyy", Locale.ENGLISH).parse(t);
            return new java.text.SimpleDateFormat("yyyy-MM-dd").format(d);
        } catch (Exception ignored) { /* keep original */ }
        return t;
    }

    /**
     * Pick the best option(s) for a multiple-choice / dropdown / rating question,
     * grounded in the candidate's profile. Returns option labels exactly as given.
     */
    public Map<String, Object> choose(String question, List<String> options, boolean multi) {
        if (question == null || question.isBlank() || options == null || options.isEmpty()) {
            throw new IllegalArgumentException("question and options are required");
        }
        Profile p = profiles.get();
        StringBuilder opts = new StringBuilder();
        for (int i = 0; i < options.size(); i++) {
            opts.append(i + 1).append(". ").append(options.get(i)).append("\n");
        }
        String system = """
                You help a candidate answer multiple-choice / rating questions — like a career coach,
                but choose the answer a sensible applicant would actually give.
                - LEGAL / BACKGROUND / COMPLIANCE questions (criminal record, charged, convicted, arrested,
                  warrant, summons, investigation, sanctions, bankruptcy, litigation, disciplinary action,
                  conflict of interest, visa overstay): answer the STANDARD TRUTHFUL way — for a normal
                  candidate this is the clean/negative option (usually "No"). Do NOT lean affirmative here.
                - SKILL exposure / familiarity / "do you have knowledge of X": prefer the AFFIRMATIVE option
                  (Yes, or a mid-to-high rating). A software engineer can honestly claim basic working
                  familiarity with common tech and is a fast learner — avoid "No"/"None" unless impossible.
                - Rating scales (1-10) for skills: a solid mid-to-high number (around 6-8), never the lowest.
                - Eligibility facts (location, relocation, start date, work authorization, WFO/on-site):
                  stay honest and eligibility-friendly (willing to relocate / comfortable with on-site / can start soon).
                Reply with ONLY the option number(s); separate multiple with commas. Just numbers.""";
        String prompt = "Candidate background:\n" + profileContext(p)
                + "\n\nQuestion: " + question.trim()
                + "\n\nOptions:\n" + opts
                + "\n" + (multi ? "Select all that apply." : "Select exactly one.")
                + " Reply with the number(s) only:";
        String raw = ai.complete(system, prompt, true, false);

        List<String> selected = new ArrayList<>();
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\d+").matcher(raw == null ? "" : raw);
        while (m.find()) {
            int idx = Integer.parseInt(m.group()) - 1;
            if (idx >= 0 && idx < options.size() && !selected.contains(options.get(idx))) {
                selected.add(options.get(idx));
                if (!multi) break;
            }
        }
        if (selected.isEmpty() && !multi) selected.add(options.get(0)); // safe fallback
        return Map.of("selected", selected);
    }

    /**
     * Map a batch of form-field labels to concrete answers from the candidate's full
     * profile. Lets the extension fill fields the synonym engine misses (CTC, college,
     * coding-profile links, etc.) by actually understanding each label.
     */
    public Map<String, String> autofill(List<String> fields) {
        if (fields == null || fields.isEmpty()) return Map.of();
        Profile p = profiles.get();
        List<String> clean = fields.stream().filter(f -> f != null && !f.isBlank())
                .map(String::trim).distinct().limit(40).toList();
        if (clean.isEmpty()) return Map.of();

        StringBuilder list = new StringBuilder();
        for (String f : clean) list.append("- ").append(f).append("\n");

        String system = """
                You fill out job-application form fields from a candidate's profile. You are given
                the full profile and a list of field labels. Return a JSON object mapping EACH label
                (verbatim) to the best answer drawn from the profile. Rules:
                - MAP BY MEANING, not exact wording — every ATS names fields differently. Examples:
                  "Present employer / Current organisation / Employer name" -> current company;
                  "Contact no. / Mobile / Phone number / WhatsApp" -> phone;
                  "Expected remuneration / ECTC / Salary expectation" -> expected CTC;
                  "Passout year / Year of completion / Graduation year" -> education year;
                  "Current location / City you reside in / Base location" -> location;
                  "Total experience / Relevant experience (years)" -> years of experience;
                  "Designation / Job title / Current role" -> current title. Apply the same
                  reasoning to ANY label whose sense matches profile data.
                - Use the literal value for factual fields (CTC as the number, links as the full URL,
                  notice period, location, etc.).
                - CONVENTIONAL fields may get the standard sensible answer even when the profile is
                  silent (these are not inventions): "How did you hear about us/this job" -> "LinkedIn";
                  "Willing to relocate" -> "Yes"; "Notice period" when absent -> "Immediate";
                  "Available to start / Earliest start date" -> "Immediately"; "Preferred work mode"
                  -> "Open to onsite, hybrid or remote"; salutation/"Title" -> from gender if known.
                - EDUCATION mapping (use the Education section, NOT the headline/summary):
                  "School / University / College / Institution" -> the school NAME only;
                  "Degree / Qualification" -> the degree (e.g. Bachelors Degree);
                  "Field of study / Major / Discipline / Specialization" -> the field (e.g. Computer Science);
                  graduation "Year" -> the year.
                - DATE ranges ("From"/"To"/"Start"/"End") -> use the matching Education year or Work
                  experience From/To; keep the format the field expects (e.g. MM/YYYY or YYYY-MM).
                - If the Education section is empty, you MAY infer Degree and Field of study from the
                  headline/summary (e.g. "Computer Science Engineering graduate" -> Degree "Bachelors
                  Degree", Field of study "Computer Science"). This is reasonable, not invention.
                - If the profile genuinely has no basis for a field, map it to "" — never invent
                  employers, schools, names, numbers or dates.
                - Keep answers short and form-appropriate. Output ONLY the JSON object.""";
        String prompt = "PROFILE:\n" + fullProfileContext(p) + "\n\nFIELDS:\n" + list + "\nJSON:";

        try {
            String raw = ai.complete(system, prompt, true, false);
            com.fasterxml.jackson.databind.JsonNode json = new com.fasterxml.jackson.databind.ObjectMapper().readTree(stripFence(raw));
            Map<String, String> out = new LinkedHashMap<>();
            for (String f : clean) {
                String v = json.path(f).asText("");
                if (v != null && !v.isBlank() && !"null".equalsIgnoreCase(v)) out.put(f, v.trim());
            }
            return out;
        } catch (Exception e) {
            return Map.of();
        }
    }

    /**
     * Side-panel copilot: interpret a free-form instruction about the current page and
     * return a structured action — fill a specific field, answer a question to paste, or reply.
     */
    public Map<String, Object> command(String instruction, List<String> fields) {
        if (instruction == null || instruction.isBlank()) throw new IllegalArgumentException("instruction is required");
        Profile p = profiles.get();
        String list = fields == null ? "" : fields.stream().filter(f -> f != null && !f.isBlank())
                .map(String::trim).distinct().limit(60).map(f -> "- " + f).reduce("", (a, b) -> a + b + "\n");

        String system = """
                You are a form-filling copilot inside a browser side panel. Given the user's
                instruction, the fields visible on the current page, and the candidate's profile,
                respond with STRICT JSON only (no prose), choosing ONE action:
                - Fill a field:    {"action":"fill","field":"<EXACT label from the field list>","value":"<value>"}
                - Answer to paste: {"action":"answer","question":"<the clean form question>","value":"<concise honest answer>"}
                - Save a Q&A:      {"action":"save","question":"<the clean form question>","answer":"<answer>"}
                - Save this job:   {"action":"save_job"}
                - Plain reply:     {"action":"reply","message":"<short reply>"}

                RULES:
                - If the user asks to SAVE / ADD / REMEMBER a question for autofill, use "save".
                  Extract ONLY the clean form question — strip the user's meta words (e.g. "can you
                  add this to autofill", "save this") and any trailing option list like "Yes No".
                  Always include your best "answer" too.
                - For "answer", also include the clean "question" you are answering (no meta words),
                  so it can be saved cleanly later.
                - If the user asks to save / scan THE JOB, JD, listing or posting, use "save_job".
                - Act as a career coach: present the candidate in the best honest light. For skill
                  questions ("Exposure to PyTorch?") claim basic/foundational familiarity + eagerness,
                  never a flat "no". Never fabricate employers, degrees or year counts.""";
        String prompt = "PROFILE:\n" + fullProfileContext(p)
                + "\n\nFIELDS ON PAGE:\n" + (list.isBlank() ? "(none detected)" : list)
                + "\nUSER INSTRUCTION: " + instruction.trim() + "\n\nJSON:";

        try {
            String raw = ai.complete(system, prompt, false, false);
            com.fasterxml.jackson.databind.JsonNode j = new com.fasterxml.jackson.databind.ObjectMapper().readTree(stripFence(raw));
            String action = j.path("action").asText("reply");
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("action", action);
            if (j.has("field")) out.put("field", j.path("field").asText(""));
            if (j.has("value")) out.put("value", j.path("value").asText(""));
            if (j.has("question")) out.put("question", j.path("question").asText(""));
            if (j.has("answer")) out.put("answer", j.path("answer").asText(""));
            if (j.has("message")) out.put("message", j.path("message").asText(""));
            // Auto-persist a save action.
            if ("save".equals(action) && j.has("question") && j.has("answer")) {
                saveQa(j.path("question").asText(), j.path("answer").asText());
            }
            return out;
        } catch (Exception e) {
            return Map.of("action", "reply", "message", "Sorry, I couldn't process that: " + e.getMessage());
        }
    }

    /** Extract clean job-posting details from raw page text (used when DOM heuristics are weak). */
    public Map<String, String> scanJob(String text, String titleHint, String url) {
        if (!ai.isEnabled() || (text == null && titleHint == null)) return Map.of();
        String sys = """
                Extract the JOB POSTING details from the page text. Return STRICT JSON only:
                {"title":"<job/role title>","company":"<hiring company>","location":"<job location>"}
                - title is the ROLE (e.g. "Software Engineering Intern"), NOT the website/page name.
                - company is the employer, NOT the job board / domain.
                - Use "" for anything not clearly present. Output ONLY the JSON.""";
        String body = text == null ? "" : text;
        if (body.length() > 4000) body = body.substring(0, 4000);
        String prompt = "URL: " + s(url) + "\nPAGE TITLE: " + s(titleHint) + "\n\nPAGE TEXT:\n" + body + "\n\nJSON:";
        try {
            com.fasterxml.jackson.databind.JsonNode j = new com.fasterxml.jackson.databind.ObjectMapper()
                    .readTree(stripFence(ai.complete(sys, prompt, true, false)));
            Map<String, String> out = new LinkedHashMap<>();
            out.put("title", j.path("title").asText(""));
            out.put("company", j.path("company").asText(""));
            out.put("location", j.path("location").asText(""));
            return out;
        } catch (Exception e) {
            return Map.of();
        }
    }

    private static String stripFence(String s) {
        if (s == null) return "{}";
        String t = s.trim();
        if (t.startsWith("```")) t = t.replaceAll("(?s)```(json)?", "").trim();
        int a = t.indexOf('{'), b = t.lastIndexOf('}');
        return (a >= 0 && b > a) ? t.substring(a, b + 1) : t;
    }

    private String fullProfileContext(Profile p) {
        StringBuilder sb = new StringBuilder();
        line(sb, "Full name", p.getFullName());
        line(sb, "Email", p.getEmail());
        line(sb, "Phone", p.getPhone());
        line(sb, "Location", p.getLocation());
        line(sb, "City", p.getCity());
        line(sb, "State", p.getState());
        line(sb, "Country", p.getCountry());
        line(sb, "Postal code", p.getPostalCode());
        line(sb, "College / University", p.getCollege());
        line(sb, "Headline", p.getHeadline());
        line(sb, "Current role", join(p.getCurrentTitle(), p.getCurrentCompany()));
        line(sb, "Years of experience", str(p.getYearsExperience()));
        line(sb, "Seniority", p.getSeniority());
        line(sb, "Current CTC / salary", p.getCurrentCtc());
        line(sb, "Expected CTC / salary", p.getExpectedCtc());
        line(sb, "Notice period", p.getNoticePeriod());
        line(sb, "Available from", p.getAvailableFrom());
        line(sb, "Work authorization", p.getWorkAuthorization());
        line(sb, "Willing to relocate", p.getWillingToRelocate() == null ? null : (p.getWillingToRelocate() ? "Yes" : "No"));
        if (p.getSkills() != null && !p.getSkills().isEmpty()) line(sb, "Skills", String.join(", ", p.getSkills()));
        if (p.getLinks() != null) p.getLinks().forEach((k, v) -> line(sb, "Link (" + k + ")", v));

        // Structured education — so labels like "School or University", "Degree" and
        // "Field of Study" map to the right value (not the headline/summary).
        if (p.getEducation() != null && !p.getEducation().isEmpty()) {
            sb.append("Education:\n");
            for (Map<String, Object> e : p.getEducation()) {
                String school = s(e.get("school"));
                if (school.isBlank() && s(e.get("degree")).isBlank() && s(e.get("field")).isBlank()) continue;
                sb.append("  - School/University/College name: ").append(school.isBlank() ? "(unspecified)" : school);
                if (!s(e.get("degree")).isBlank()) sb.append(" | Degree: ").append(s(e.get("degree")));
                if (!s(e.get("field")).isBlank()) sb.append(" | Field of study / Major / Discipline: ").append(s(e.get("field")));
                if (!s(e.get("year")).isBlank()) sb.append(" | Year / graduation: ").append(s(e.get("year")));
                sb.append("\n");
            }
        }
        // Structured experience — for "From/To" dates, company and title fields.
        if (p.getExperience() != null && !p.getExperience().isEmpty()) {
            sb.append("Work experience:\n");
            for (Map<String, Object> e : p.getExperience()) {
                String company = s(e.get("company"));
                if (company.isBlank() && s(e.get("title")).isBlank()) continue;
                sb.append("  - Company: ").append(company.isBlank() ? "(unspecified)" : company);
                if (!s(e.get("title")).isBlank()) sb.append(" | Title: ").append(s(e.get("title")));
                if (!s(e.get("start")).isBlank()) sb.append(" | From: ").append(s(e.get("start")));
                if (!s(e.get("end")).isBlank()) sb.append(" | To: ").append(s(e.get("end")));
                sb.append("\n");
            }
        }
        line(sb, "Summary", p.getSummary());
        return sb.length() == 0 ? "(no profile details)" : sb.toString();
    }

    private static String s(Object o) { return o == null ? "" : o.toString().trim(); }

    @Transactional
    public QaPair saveQa(String question, String answer) {
        if (question == null || question.isBlank() || answer == null || answer.isBlank()) {
            throw new IllegalArgumentException("question and answer are required");
        }
        return save(UserContext.require(), question, answer, "manual");
    }

    public List<QaPair> listQa() {
        return qaRepo.findByUserIdOrderByUpdatedAtDesc(UserContext.require());
    }

    @Transactional
    public void deleteQa(UUID id) {
        UUID userId = UserContext.require();
        qaRepo.findById(id).filter(q -> userId.equals(q.getUserId())).ifPresent(qaRepo::delete);
    }

    @Transactional
    public QaPair updateQa(UUID id, String question, String answer) {
        UUID userId = UserContext.require();
        QaPair q = qaRepo.findById(id).filter(x -> userId.equals(x.getUserId()))
                .orElseThrow(() -> new IllegalArgumentException("saved answer not found"));
        if (question != null && !question.isBlank()) { q.setQuestion(question.trim()); q.setQuestionKey(normalize(question)); }
        if (answer != null && !answer.isBlank()) q.setAnswer(answer.trim());
        q.setUpdatedAt(Instant.now());
        return qaRepo.save(q);
    }

    /** Generate a cover letter for an arbitrary listing the extension is looking at. */
    public String coverLetter(String company, String role, String jobText) {
        Profile p = profiles.get();
        Job job = new Job();
        job.setCompany(company == null || company.isBlank() ? "the company" : company.trim());
        job.setTitle(role == null || role.isBlank() ? "this role" : role.trim());
        job.setDescription(jobText == null ? "" : jobText.trim());
        return coverLetters.generate(job, p);
    }

    // ---- internals ----

    private QaPair save(UUID userId, String question, String answer, String source) {
        String key = normalize(question);
        QaPair q = qaRepo.findByUserIdAndQuestionKey(userId, key).orElseGet(QaPair::new);
        q.setUserId(userId);
        q.setQuestion(question.trim());
        q.setQuestionKey(key);
        q.setAnswer(answer.trim());
        if (q.getId() == null) q.setSource(source);
        q.setUpdatedAt(Instant.now());
        return qaRepo.save(q);
    }

    private static String normalize(String s) {
        return s.toLowerCase().replaceAll("[^a-z0-9 ]", " ").replaceAll("\\s+", " ").trim();
    }

    /** Returns a stored Q&A whose question tokens overlap the asked one strongly (Jaccard >= 0.6). */
    private QaPair bestMatch(List<QaPair> bank, String key) {
        Set<String> want = tokens(key);
        if (want.isEmpty()) return null;
        QaPair best = null;
        double bestScore = 0.6;
        for (QaPair q : bank) {
            Set<String> have = tokens(q.getQuestionKey());
            if (have.isEmpty()) continue;
            Set<String> inter = new HashSet<>(want);
            inter.retainAll(have);
            Set<String> union = new HashSet<>(want);
            union.addAll(have);
            double j = (double) inter.size() / union.size();
            if (j > bestScore) { bestScore = j; best = q; }
        }
        return best;
    }

    private static Set<String> tokens(String key) {
        return Arrays.stream(key.split(" ")).filter(t -> t.length() > 2).collect(Collectors.toSet());
    }

    private String profileContext(Profile p) {
        StringBuilder sb = new StringBuilder();
        line(sb, "Name", p.getFullName());
        line(sb, "Headline", p.getHeadline());
        line(sb, "Current role", join(p.getCurrentTitle(), p.getCurrentCompany()));
        line(sb, "Years of experience", str(p.getYearsExperience()));
        line(sb, "Location", p.getLocation());
        if (p.getSkills() != null && !p.getSkills().isEmpty()) {
            line(sb, "Skills", String.join(", ", p.getSkills()));
        }
        line(sb, "Summary", p.getSummary());
        return sb.length() == 0 ? "(no profile details on file)" : sb.toString();
    }

    private static void line(StringBuilder sb, String label, String val) {
        if (val != null && !val.isBlank()) sb.append("- ").append(label).append(": ").append(val).append("\n");
    }

    private static String join(String a, String b) {
        if (a == null || a.isBlank()) return b;
        if (b == null || b.isBlank()) return a;
        return a + " at " + b;
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }
}
