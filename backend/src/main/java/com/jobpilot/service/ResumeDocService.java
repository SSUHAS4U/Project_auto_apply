package com.jobpilot.service;

import com.jobpilot.domain.Profile;
import com.jobpilot.domain.ResumeDoc;
import com.jobpilot.repository.ResumeDocRepository;
import com.jobpilot.security.UserContext;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Overleaf-style LaTeX resume manager:
 *  - named LaTeX documents per user, one marked as BASE (the original);
 *  - per-JD tailored copies (AI rewrites the base to emphasise the JD, honestly);
 *  - compile to PDF through the free texlive.net service (no local TeX install,
 *    works on the 256MB Render free tier);
 *  - stored PDFs are what the extension offers in its "which resume?" picker.
 */
@Service
public class ResumeDocService {

    private static final Logger log = LoggerFactory.getLogger(ResumeDocService.class);

    private final ResumeDocRepository repo;
    private final ProfileService profiles;
    private final AiService ai;
    private final RestClient http;

    @Value("${jobpilot.latex.compile-url:https://texlive.net/cgi-bin/latexcgi}")
    private String compileUrl;

    public ResumeDocService(ResumeDocRepository repo, ProfileService profiles,
                            AiService ai, RestClient http) {
        this.repo = repo;
        this.profiles = profiles;
        this.ai = ai;
        this.http = http;
    }

    // ---- CRUD -----------------------------------------------------------------

    public List<ResumeDoc> list() {
        return repo.findByUserIdOrderByUpdatedAtDesc(UserContext.require());
    }

    public ResumeDoc get(UUID id) {
        return repo.findByIdAndUserId(id, UserContext.require())
                .orElseThrow(() -> new NotFoundException("resume not found"));
    }

    /**
     * Create a resume: from another doc ({@code fromId}), with given LaTeX, or —
     * when neither is provided — a starter template pre-filled from the profile
     * ("blank" still gives a compilable skeleton to type into).
     */
    @Transactional
    public ResumeDoc create(String name, String latex, UUID fromId, boolean blank) {
        UUID userId = UserContext.require();
        ResumeDoc d = new ResumeDoc();
        d.setUserId(userId);
        d.setName(name == null || name.isBlank() ? "Untitled resume" : name.trim());
        if (fromId != null) {
            ResumeDoc src = repo.findByIdAndUserId(fromId, userId)
                    .orElseThrow(() -> new NotFoundException("source resume not found"));
            d.setLatex(src.getLatex());
        } else if (latex != null && !latex.isBlank()) {
            d.setLatex(latex);
        } else if (blank) {
            d.setLatex(BLANK_TEMPLATE);
        } else {
            d.setLatex(starterTemplate(profiles.get()));
        }
        // First-ever document becomes the base automatically.
        if (repo.findFirstByUserIdAndBaseTrue(userId).isEmpty()) d.setBase(true);
        return repo.save(d);
    }

    @Transactional
    public ResumeDoc update(UUID id, String name, String latex) {
        ResumeDoc d = get(id);
        if (name != null && !name.isBlank()) d.setName(name.trim());
        if (latex != null) {
            if (!latex.equals(d.getLatex())) d.setPdf(null); // source changed -> stale PDF
            d.setLatex(latex);
        }
        d.setUpdatedAt(Instant.now());
        return repo.save(d);
    }

    @Transactional
    public void delete(UUID id) {
        repo.delete(get(id));
    }

    /** Mark this document as the base (the "original") — unmarks the previous one. */
    @Transactional
    public ResumeDoc setBase(UUID id) {
        UUID userId = UserContext.require();
        repo.findFirstByUserIdAndBaseTrue(userId).ifPresent(prev -> {
            prev.setBase(false);
            repo.save(prev);
        });
        ResumeDoc d = get(id);
        d.setBase(true);
        d.setUpdatedAt(Instant.now());
        return repo.save(d);
    }

    public byte[] pdf(UUID id) {
        ResumeDoc d = get(id);
        if (d.getPdf() == null || d.getPdf().length == 0) {
            throw new IllegalStateException("No compiled PDF yet — compile this resume first.");
        }
        return d.getPdf();
    }

    // ---- compile ---------------------------------------------------------------

    /** Compile the document's LaTeX to PDF (free texlive.net service) and store it. */
    @Transactional
    public byte[] compile(UUID id) {
        ResumeDoc d = get(id);
        byte[] pdf = compileLatex(d.getLatex());
        d.setPdf(pdf);
        d.setUpdatedAt(Instant.now());
        repo.save(d);
        return pdf;
    }

    byte[] compileLatex(String latex) {
        if (latex == null || latex.isBlank()) throw new IllegalArgumentException("empty LaTeX source");
        String engine = engineFor(latex);
        // Two independent free services: texlive.net first, latex.ytotech.com as the
        // fallback (texlive.net rejects some datacenter IPs — e.g. Render's — with a
        // block page instead of compiling).
        try {
            return compileViaTexlive(latex, engine);
        } catch (RuntimeException first) {
            // A real LaTeX error is the same on any service — don't retry those.
            if (first.getMessage() != null && first.getMessage().contains("LaTeX Error")) throw first;
            log.warn("texlive.net compile failed ({}), trying latex.ytotech.com", first.getMessage());
            try {
                return compileViaYtotech(latex, engine);
            } catch (RuntimeException second) {
                throw new IllegalStateException(second.getMessage() + " [texlive.net also failed: "
                        + first.getMessage() + "]", second);
            }
        }
    }

    private byte[] compileViaTexlive(String latex, String engine) {
        MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
        form.add("filecontents[]", latex);
        form.add("filename[]", "document.tex");
        form.add("engine", engine);
        form.add("return", "pdf");

        // texlive.net answers 301 → /latexcgi/<doc>.pdf on success or <doc>.log on failure;
        // the redirect must be followed manually (RestClient won't re-issue a POST redirect).
        int status;
        String location;
        byte[] body;
        try {
            var result = http.post().uri(compileUrl)
                    .contentType(MediaType.MULTIPART_FORM_DATA)
                    .body(form)
                    .exchange((request, response) -> {
                        String loc = response.getHeaders().getFirst("Location");
                        byte[] b = response.getBody().readAllBytes();
                        return new Object[]{response.getStatusCode().value(), loc == null ? "" : loc, b};
                    });
            status = (Integer) result[0];
            location = (String) result[1];
            body = (byte[]) result[2];
        } catch (Exception e) {
            throw new IllegalStateException("LaTeX compile service unreachable: " + e.getMessage(), e);
        }

        if (!location.isBlank()) {
            byte[] fetched = fetchCompiled(location);
            if (location.endsWith(".pdf") && isPdf(fetched)) return fetched;
            String err = firstErrorLine(fetched == null ? "" : new String(fetched, StandardCharsets.UTF_8));
            throw new IllegalStateException("LaTeX compile failed" + (err.isBlank() ? "" : ": " + err));
        }
        if (isPdf(body)) return body; // some latexcgi deployments return the PDF inline
        String text = body == null ? "" : new String(body, StandardCharsets.UTF_8);
        String err = firstErrorLine(text);
        if (err.isBlank()) {
            // No log errors and no redirect: the service didn't compile at all (block page,
            // maintenance, etc.) — include what came back so the failure is diagnosable.
            String snip = text.replaceAll("\\s+", " ").trim();
            if (snip.length() > 160) snip = snip.substring(0, 160);
            err = "service returned HTTP " + status + (snip.isBlank() ? " with an empty body" : " with \"" + snip + "\"");
        }
        throw new IllegalStateException("LaTeX compile failed: " + err);
    }

    /** latex.ytotech.com (latex-on-http) — free JSON API, returns the PDF directly. */
    private byte[] compileViaYtotech(String latex, String engine) {
        byte[] body;
        try {
            body = http.post().uri("https://latex.ytotech.com/builds/sync")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(java.util.Map.of(
                            "compiler", engine, // ytotech accepts pdflatex / xelatex / lualatex
                            "resources", java.util.List.of(java.util.Map.of("main", true, "content", latex))))
                    .exchange((request, response) -> response.getBody().readAllBytes());
        } catch (Exception e) {
            throw new IllegalStateException("LaTeX compile service unreachable: " + e.getMessage(), e);
        }
        if (isPdf(body)) return body;
        String text = body == null ? "" : new String(body, StandardCharsets.UTF_8);
        // Error responses are JSON with the full compile log inside.
        String err = firstErrorLine(text.replace("\\n", "\n"));
        if (err.isBlank() && !text.isBlank()) {
            err = text.replaceAll("\\s+", " ").trim();
            err = err.substring(0, Math.min(200, err.length()));
        }
        throw new IllegalStateException("LaTeX compile failed" + (err.isBlank() ? "" : ": " + err));
    }

    /** Fetch the redirect target (PDF or compile log), resolving relative paths against the service URL. */
    private byte[] fetchCompiled(String location) {
        java.net.URI target = location.startsWith("http")
                ? java.net.URI.create(location)
                : java.net.URI.create(compileUrl).resolve(location);
        try {
            return http.get().uri(target).retrieve().body(byte[].class);
        } catch (Exception e) {
            throw new IllegalStateException("could not fetch compile result: " + e.getMessage(), e);
        }
    }

    private static boolean isPdf(byte[] b) {
        return b != null && b.length >= 5 && b[0] == '%' && b[1] == 'P' && b[2] == 'D' && b[3] == 'F';
    }

    /**
     * Pick the TeX engine the source needs — Overleaf templates using fontspec /
     * FontAwesome5 / unicode-math require XeLaTeX (pdflatex can't load OpenType fonts).
     */
    static String engineFor(String latex) {
        if (latex.contains("luacode") || latex.contains("directlua")) return "lualatex";
        if (latex.contains("fontspec") || latex.contains("\\setmainfont")
                || latex.contains("unicode-math") || latex.contains("fontawesome5")
                || latex.contains("polyglossia")) return "xelatex";
        return "pdflatex";
    }

    /** Up to the first three distinct "!" error lines plus the "l.NN" source-line hint. */
    private static String firstErrorLine(String logText) {
        java.util.LinkedHashSet<String> errs = new java.util.LinkedHashSet<>();
        String lineHint = null;
        for (String line : logText.split("\n")) {
            String t = line.trim().replaceAll("<[^>]*>", "");
            if (t.startsWith("!") && errs.size() < 3) errs.add(t.replaceFirst("^!\\s*", ""));
            if (lineHint == null && t.matches("^l\\.\\d+.*")) lineHint = t;
        }
        errs.remove("Emergency stop.");
        errs.remove("==> Fatal error occurred, no output PDF file produced!");
        String out = String.join(" | ", errs);
        return lineHint == null ? out : out + " (" + lineHint + ")";
    }

    // ---- AI tailor -------------------------------------------------------------

    private static final String TAILOR_SYSTEM = """
            You tailor a LaTeX resume to a specific job description. Rules:
            - Keep the SAME LaTeX structure, packages, formatting and length (one page).
            - Reorder/reword bullet points and the skills section to emphasise what the JD asks
              for. Mirror the JD's terminology where the candidate genuinely has that skill.
            - NEVER invent employers, degrees, projects, dates or skills not present in the
              original resume. Rewording and reprioritising only.
            - The output MUST compile: escape special characters (&, %, #, _) exactly like the
              original does. Output ONLY the complete LaTeX source, no fences, no commentary.""";

    /** Duplicate the base resume, AI-tailored to the given JD, saved under a JD-derived name. */
    @Transactional
    public ResumeDoc tailor(String name, String jobUrl, String jdText) {
        UUID userId = UserContext.require();
        ResumeDoc base = repo.findFirstByUserIdAndBaseTrue(userId)
                .orElseThrow(() -> new IllegalStateException(
                        "No base resume yet — create one in Dashboard → Resumes first."));
        String cleanName = name == null || name.isBlank() ? "Tailored resume" : name.trim();

        String latex = base.getLatex();
        if (jdText != null && !jdText.isBlank() && ai.isEnabled()) {
            String jd = jdText.length() > 6000 ? jdText.substring(0, 6000) : jdText;
            try {
                String out = ai.complete(TAILOR_SYSTEM,
                        "ORIGINAL RESUME (LaTeX):\n" + base.getLatex()
                                + "\n\nJOB DESCRIPTION:\n" + jd + "\n\nTailored LaTeX:", false, true);
                String stripped = stripFences(out);
                // Only accept output that still looks like a full LaTeX document.
                if (stripped.contains("\\documentclass") && stripped.contains("\\end{document}")) {
                    latex = stripped;
                }
            } catch (Exception e) {
                log.warn("AI tailor failed, duplicating base as-is: {}", e.getMessage());
            }
        }

        ResumeDoc d = new ResumeDoc();
        d.setUserId(userId);
        d.setName(cleanName);
        d.setLatex(latex);
        d.setJobUrl(jobUrl);
        d.setJdText(jdText);
        return repo.save(d);
    }

    private static String stripFences(String s) {
        if (s == null) return "";
        String t = s.trim();
        if (t.startsWith("```")) t = t.replaceAll("(?s)^```(latex|tex)?\\s*", "").replaceAll("```\\s*$", "");
        return t.trim();
    }

    // ---- templates ---------------------------------------------------------------

    private static final String BLANK_TEMPLATE = """
            \\documentclass[11pt,a4paper]{article}
            \\usepackage[margin=1.8cm]{geometry}
            \\usepackage[hidelinks]{hyperref}
            \\usepackage{enumitem}
            \\setlist{nosep,leftmargin=1.2em}
            \\pagestyle{empty}
            \\begin{document}

            % Start typing your resume here…

            \\end{document}
            """;

    /** A clean, compilable one-page starter pre-filled from the profile. */
    String starterTemplate(Profile p) {
        String name = esc(or(p.getFullName(), "Your Name"));
        String email = esc(or(p.getEmail(), "you@example.com"));
        String phone = esc(or(p.getPhone(), "+91 00000 00000"));
        String location = esc(or(p.getLocation(), "City, India"));
        String headline = esc(or(p.getHeadline(), "Software Engineer"));
        Map<String, String> links = p.getLinks() == null ? Map.of() : p.getLinks();
        String linkedin = or(links.get("linkedin"), "");
        String github = or(links.get("github"), "");

        StringBuilder skills = new StringBuilder();
        if (p.getSkills() != null && !p.getSkills().isEmpty()) {
            skills.append(esc(String.join(", ", p.getSkills())));
        } else {
            skills.append("Java, Spring Boot, React, PostgreSQL");
        }

        StringBuilder edu = new StringBuilder();
        if (p.getEducation() != null) {
            for (Map<String, Object> e : p.getEducation()) {
                String school = esc(str(e.get("school")));
                if (school.isBlank()) continue;
                edu.append("\\textbf{").append(school).append("}");
                String degree = esc(str(e.get("degree"))), field = esc(str(e.get("field"))), year = esc(str(e.get("year")));
                if (!degree.isBlank() || !field.isBlank()) {
                    edu.append(" \\hfill ").append(year).append("\\\\\n")
                       .append(degree).append(field.isBlank() ? "" : (degree.isBlank() ? "" : ", ") + field).append("\n\n");
                } else {
                    edu.append(" \\hfill ").append(year).append("\n\n");
                }
            }
        }
        if (edu.length() == 0) edu.append("\\textbf{Your University} \\hfill Year\\\\\nB.Tech, Computer Science\n\n");

        StringBuilder exp = new StringBuilder();
        if (p.getExperience() != null) {
            for (Map<String, Object> e : p.getExperience()) {
                String company = esc(str(e.get("company")));
                if (company.isBlank()) continue;
                exp.append("\\textbf{").append(esc(str(e.get("title")))).append("} — ").append(company)
                   .append(" \\hfill ").append(esc(str(e.get("start")))).append(" -- ").append(esc(str(e.get("end")))).append("\n")
                   .append("\\begin{itemize}\n  \\item ").append(esc(str(e.get("description")))).append("\n\\end{itemize}\n\n");
            }
        }
        if (exp.length() == 0) {
            exp.append("\\textbf{Role} — Company \\hfill From -- To\n")
               .append("\\begin{itemize}\n  \\item What you built and its impact.\n\\end{itemize}\n\n");
        }

        return """
                \\documentclass[11pt,a4paper]{article}
                \\usepackage[margin=1.6cm]{geometry}
                \\usepackage[hidelinks]{hyperref}
                \\usepackage{enumitem}
                \\usepackage{titlesec}
                \\titleformat{\\section}{\\large\\bfseries}{}{0em}{}[\\titlerule]
                \\titlespacing{\\section}{0pt}{10pt}{6pt}
                \\setlist{nosep,leftmargin=1.2em}
                \\pagestyle{empty}
                \\begin{document}

                \\begin{center}
                  {\\LARGE\\bfseries %s}\\\\[2pt]
                  %s\\\\[2pt]
                  %s \\textbar{} %s \\textbar{} %s%s%s
                \\end{center}

                \\section{Skills}
                %s

                \\section{Experience}
                %s\\section{Education}
                %s\\section{Projects}
                \\textbf{Project name} — short one-line description of what it does.
                \\begin{itemize}
                  \\item Tech used and what you achieved.
                \\end{itemize}

                \\end{document}
                """.formatted(
                name, headline, email, phone, location,
                linkedin.isBlank() ? "" : " \\textbar{} \\href{" + linkedin + "}{LinkedIn}",
                github.isBlank() ? "" : " \\textbar{} \\href{" + github + "}{GitHub}",
                skills, exp, edu);
    }

    private static String or(String a, String b) { return a == null || a.isBlank() ? b : a; }
    private static String str(Object o) { return o == null ? "" : o.toString().trim(); }

    /** Escape LaTeX special characters in plain-text values. */
    private static String esc(String s) {
        if (s == null) return "";
        // Escape braces/symbols first, using a placeholder for backslash so the
        // replacement text's own braces don't get double-escaped.
        String t = s.replace("\\", "\u0000")
                .replace("{", "\\{").replace("}", "\\}")
                .replace("&", "\\&").replace("%", "\\%").replace("$", "\\$")
                .replace("#", "\\#").replace("_", "\\_")
                .replace("~", "\\textasciitilde{}").replace("^", "\\textasciicircum{}");
        return t.replace("\u0000", "\\textbackslash{}");
    }
}
