package com.jobpilot.engine;

import com.jobpilot.service.ProfileService;
import com.jobpilot.service.ai.AiService;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.text.PDFTextStripper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * /setup — the repo's three-path onboarding, clean-room:
 *   Path A: scan stored material (the uploaded resume PDF's text),
 *   Path B: pasted CV text,
 *   Path C: guided interview answers.
 * Generates the profile documents (01..07 + search-queries) that every other engine
 * command reads. Idempotent: re-running with more material regenerates the docs;
 * hand-edited docs can also be saved directly from the dashboard.
 */
@Service
public class EngineSetupService {

    private static final Logger log = LoggerFactory.getLogger(EngineSetupService.class);

    private final EngineProfileRepository profiles;
    private final AiService ai;
    private final ProfileService appProfile; // shared resource: only the stored resume bytes

    public EngineSetupService(EngineProfileRepository profiles, AiService ai, ProfileService appProfile) {
        this.profiles = profiles;
        this.ai = ai;
        this.appProfile = appProfile;
    }

    public EngineProfile get(UUID userId) {
        return profiles.findByUserId(userId).orElseGet(() -> {
            EngineProfile p = new EngineProfile();
            p.setUserId(userId);
            p.setCoverTemplateLatex(DEFAULT_COVER_TEMPLATE);
            return profiles.save(p);
        });
    }

    /** Which docs exist — the dashboard's setup checklist. */
    public Map<String, Boolean> checklist(UUID userId) {
        EngineProfile p = get(userId);
        Map<String, Boolean> m = new LinkedHashMap<>();
        m.put("candidate", filled(p.getCandidateMd()));
        m.put("behavioral", filled(p.getBehavioralMd()));
        m.put("writingStyle", filled(p.getWritingStyleMd()));
        m.put("evaluation", filled(p.getEvaluationMd()));
        m.put("cvTemplate", filled(p.getCvTemplateLatex()));
        m.put("coverTemplate", filled(p.getCoverTemplateLatex()));
        m.put("interviewPrep", filled(p.getInterviewPrepMd()));
        m.put("searchQueries", filled(p.getSearchQueries()));
        return m;
    }

    public boolean isReady(UUID userId) {
        EngineProfile p = get(userId);
        return filled(p.getCandidateMd()) && filled(p.getCvTemplateLatex()) && filled(p.getSearchQueries());
    }

    /** Save a hand-edited doc from the dashboard. */
    @Transactional
    public EngineProfile saveDoc(UUID userId, String doc, String content) {
        EngineProfile p = get(userId);
        switch (doc) {
            case "candidate" -> p.setCandidateMd(content);
            case "behavioral" -> p.setBehavioralMd(content);
            case "writingStyle" -> p.setWritingStyleMd(content);
            case "evaluation" -> p.setEvaluationMd(content);
            case "cvTemplate" -> p.setCvTemplateLatex(content);
            case "coverTemplate" -> p.setCoverTemplateLatex(content);
            case "interviewPrep" -> p.setInterviewPrepMd(content);
            case "searchQueries" -> p.setSearchQueries(content);
            default -> throw new IllegalArgumentException("unknown doc: " + doc);
        }
        p.setUpdatedAt(Instant.now());
        return profiles.save(p);
    }

    /**
     * Run setup: gather source material (paths A/B/C combined), then generate every
     * profile document. Returns the refreshed profile.
     */
    @Transactional
    public EngineProfile run(UUID userId, String pastedCv, String interviewAnswers, boolean useStoredResume) {
        if (!ai.isEnabled()) throw new IllegalStateException("No AI provider configured — set one in Settings first.");

        StringBuilder material = new StringBuilder();
        StringBuilder logLine = new StringBuilder("Setup " + Instant.now() + ": ");
        if (useStoredResume) {
            String resumeText = storedResumeText();
            if (!resumeText.isBlank()) {
                material.append("=== RESUME (extracted from uploaded PDF) ===\n").append(resumeText).append("\n\n");
                logLine.append("stored resume ✓ ");
            }
        }
        if (pastedCv != null && !pastedCv.isBlank()) {
            material.append("=== PASTED CV / CAREER MATERIAL ===\n").append(pastedCv.trim()).append("\n\n");
            logLine.append("pasted CV ✓ ");
        }
        if (interviewAnswers != null && !interviewAnswers.isBlank()) {
            material.append("=== GUIDED INTERVIEW ANSWERS ===\n").append(interviewAnswers.trim()).append("\n\n");
            logLine.append("interview answers ✓ ");
        }
        EngineProfile p = get(userId);
        // Idempotent enrichment: existing docs are part of the source so re-runs refine.
        if (filled(p.getCandidateMd()))
            material.append("=== EXISTING CANDIDATE PROFILE (refine, don't lose facts) ===\n")
                    .append(p.getCandidateMd()).append("\n\n");
        if (material.isEmpty())
            throw new IllegalArgumentException("No material: paste a CV, answer the interview, or upload a resume in Profile.");

        String src = cap(material.toString(), 14000);

        p.setCandidateMd(gen(CANDIDATE_SYS, src));
        p.setBehavioralMd(gen(BEHAVIORAL_SYS, src));
        p.setWritingStyleMd(gen(WRITING_SYS, src));
        p.setEvaluationMd(gen(EVALUATION_SYS, src));
        p.setInterviewPrepMd(gen(INTERVIEW_SYS, src));
        p.setSearchQueries(cleanJson(gen(QUERIES_SYS, src)));
        p.setCvTemplateLatex(gen(CV_TEMPLATE_SYS,
                "CANDIDATE PROFILE:\n" + p.getCandidateMd() + "\n\nTEMPLATE TO FILL:\n" + DEFAULT_CV_TEMPLATE));
        if (!filled(p.getCoverTemplateLatex())) p.setCoverTemplateLatex(DEFAULT_COVER_TEMPLATE);
        p.setSetupLog((p.getSetupLog() == null ? "" : p.getSetupLog() + "\n") + logLine);
        p.setUpdatedAt(Instant.now());
        log.info("Engine setup completed for user {}", userId);
        return profiles.save(p);
    }

    private String gen(String system, String user) {
        String out = ai.complete(system, cap(user, 14000), false, false);
        return out == null ? "" : stripFences(out.trim());
    }

    private String storedResumeText() {
        try {
            byte[] data = appProfile.get().getResumeData();
            if (data == null || data.length == 0) return "";
            try (var doc = Loader.loadPDF(data)) {
                return new PDFTextStripper().getText(doc);
            }
        } catch (Exception e) {
            log.warn("Could not extract stored resume text: {}", e.getMessage());
            return "";
        }
    }

    private static boolean filled(String s) { return s != null && !s.isBlank(); }

    private static String cap(String s, int max) { return s.length() > max ? s.substring(0, max) : s; }

    private static String stripFences(String s) {
        String t = s.trim();
        if (t.startsWith("```")) {
            int nl = t.indexOf('\n');
            if (nl > 0) t = t.substring(nl + 1);
            if (t.endsWith("```")) t = t.substring(0, t.length() - 3);
        }
        return t.trim();
    }

    private static String cleanJson(String s) {
        String t = stripFences(s);
        int a = t.indexOf('{');
        int b = t.lastIndexOf('}');
        return (a >= 0 && b > a) ? t.substring(a, b + 1) : "{\"keywords\":[],\"locations\":[]}";
    }

    // ---- generation prompts (clean-room, mirroring the repo's 01..07 file intents) ----

    private static final String CANDIDATE_SYS = """
            You are building 01-candidate-profile.md for a job-application assistant.
            From the source material, produce a structured markdown profile with sections:
            # Candidate Profile
            ## Contact  (name, email, phone, location, links)
            ## Summary  (3-4 sentences, factual)
            ## Education  (institution, degree, field, years, notable coursework/results)
            ## Experience (each role: company, title, dates, 3-5 bullet points with real
                          outcomes; keep every quantified fact from the source)
            ## Projects  (name, stack, what it does, evidence links)
            ## Skills    (grouped: languages, frameworks, tools, cloud/data, soft)
            ## Certifications
            STRICT HONESTY: include ONLY facts present in the source material. Never invent
            employers, dates, titles, metrics, degrees, or skills. If a section has no data,
            write "_No data yet — re-run setup with more material._" Output markdown only.""";

    private static final String BEHAVIORAL_SYS = """
            You are building 02-behavioral-profile.md. From the source material infer a
            careful behavioral profile: work style, collaboration style, strengths,
            watch-outs, motivators, and environments where this person does their best
            work. Frame inferences as inferences ("signals suggest..."), never as test
            results. Sections: # Behavioral Profile / ## Work style / ## Strengths /
            ## Watch-outs / ## Motivators / ## Ideal environment. Markdown only.""";

    private static final String WRITING_SYS = """
            You are building 03-writing-style.md — the rules every CV bullet and cover
            letter must follow for this candidate. Derive tone from the material (seniority,
            field, region) and set concrete rules: sentence length, active voice, first
            person for letters, no clichés (list 10 banned phrases like "highly motivated",
            "detail-oriented", "team player"), how to present numbers, and 3 example
            rewrites (weak line → strong line) using the candidate's real content.
            Sections: # Writing Style / ## Tone / ## Rules / ## Banned phrases /
            ## Example rewrites. Markdown only.""";

    private static final String EVALUATION_SYS = """
            You are building 04-job-evaluation.md — the candidate's own evaluation lens.
            From the material derive: ## Career goals (direction, next-role shape),
            ## Must-haves, ## Deal-breakers (things that veto a job outright — infer
            conservatively, e.g. unpaid roles; include relocation constraints only if
            stated), ## Skill match areas (what to weigh most), ## Location & logistics
            (base location, remote preference). Be specific to THIS candidate. Markdown only.""";

    private static final String INTERVIEW_SYS = """
            You are building 07-interview-prep.md. From the candidate's real experience,
            write 6-8 STAR examples (Situation, Task, Action, Result — 3-5 lines each)
            covering: a hard technical problem, teamwork/conflict, deadline pressure,
            learning something fast, a failure and recovery, initiative/leadership.
            Use ONLY real events from the material; where the material lacks an example,
            write the heading with "_Add a real example here._" Then add ## Answer rules:
            honest bridge answers for gaps, never invented experience. Markdown only.""";

    private static final String QUERIES_SYS = """
            You are building search-queries.md as JSON for a job scraper. From the material
            pick the best portal search inputs. Output STRICT JSON only:
            {"keywords":["role phrase 1","role phrase 2","role phrase 3","role phrase 4"],
             "locations":["City, Country","City2, India","Remote"]}
            Keywords are ROLE names a job portal understands (e.g. "Java Backend Developer"),
            most-likely-to-hire first, 3-6 of them. Locations: candidate's city + 2-3 nearby
            hubs + "Remote" when appropriate. No other text.""";

    private static final String CV_TEMPLATE_SYS = """
            Fill this LaTeX CV template with the candidate's REAL profile data. Replace every
            [PLACEHOLDER] with content from the profile; drop optional blocks that have no
            data. Keep the preamble and structure EXACTLY as given, keep it compiling with
            pdflatex, target a clean 2 pages max. Never invent facts. Output ONLY the
            complete LaTeX source, no commentary, no markdown fences.""";

    // ---- default templates (clean-room; placeholders in the repo's style) ----

    static final String DEFAULT_CV_TEMPLATE = """
            \\documentclass[10pt,a4paper]{article}
            \\usepackage[margin=1.6cm]{geometry}
            \\usepackage{enumitem,titlesec,xcolor,hyperref}
            \\definecolor{ink}{HTML}{1a1a2e}
            \\definecolor{accent}{HTML}{16425b}
            \\hypersetup{colorlinks=true,urlcolor=accent,linkcolor=accent}
            \\titleformat{\\section}{\\large\\bfseries\\color{accent}}{}{0em}{}[\\titlerule]
            \\titlespacing{\\section}{0pt}{8pt}{4pt}
            \\setlist[itemize]{leftmargin=1.2em,itemsep=1pt,topsep=2pt,parsep=0pt}
            \\pagestyle{empty}
            \\begin{document}
            {\\LARGE\\bfseries [FULL NAME]}\\\\[2pt]
            [HEADLINE — e.g. Full-Stack Developer]\\\\[2pt]
            [CITY] \\;\\textbullet\\; [EMAIL] \\;\\textbullet\\; [PHONE] \\;\\textbullet\\; [LINKS]

            \\section*{Summary}
            [3-4 line professional summary]

            \\section*{Skills}
            \\textbf{Languages:} [LANGUAGES] \\\\
            \\textbf{Frameworks:} [FRAMEWORKS] \\\\
            \\textbf{Tools \\& Cloud:} [TOOLS]

            \\section*{Experience}
            \\textbf{[TITLE]} — [COMPANY] \\hfill [DATES]
            \\begin{itemize}
              \\item [Achievement bullet with a real outcome]
              \\item [Achievement bullet]
            \\end{itemize}

            \\section*{Projects}
            \\textbf{[PROJECT NAME]} — [stack] \\hfill [LINK]
            \\begin{itemize}
              \\item [What it does and the result]
            \\end{itemize}

            \\section*{Education}
            \\textbf{[DEGREE], [FIELD]} — [INSTITUTION] \\hfill [YEARS]

            \\section*{Certifications}
            \\begin{itemize}
              \\item [CERTIFICATION — issuer, year]
            \\end{itemize}
            \\end{document}
            """;

    static final String DEFAULT_COVER_TEMPLATE = """
            \\documentclass[11pt,a4paper]{article}
            \\usepackage[margin=2.2cm]{geometry}
            \\usepackage{xcolor,hyperref,parskip}
            \\definecolor{accent}{HTML}{16425b}
            \\hypersetup{colorlinks=true,urlcolor=accent}
            \\pagestyle{empty}
            \\begin{document}
            {\\large\\bfseries [FULL NAME]}\\\\
            [EMAIL] \\;\\textbullet\\; [PHONE] \\;\\textbullet\\; [CITY]\\\\[14pt]
            [DATE]\\\\[10pt]
            Dear [HIRING MANAGER / TEAM],\\\\[6pt]
            [OPENING — name the role and the 2-3 concrete needs from the posting]

            [BODY — tie each need to REAL experience with evidence]

            [CLOSE — specific interest in this company, availability]\\\\[10pt]
            Sincerely,\\\\
            [FULL NAME]
            \\end{document}
            """;
}
