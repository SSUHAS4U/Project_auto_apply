package com.jobpilot.pilot;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.PdfUtil;
import com.jobpilot.service.ResumeDocService;
import com.jobpilot.service.ai.AiService;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Locale;

/**
 * apply.md Step 5 — the MANDATORY compile-and-verify stage:
 *
 *  5a. compile the tailored CV LaTeX to PDF (texlive.net; one AI repair attempt
 *      on LaTeX errors, mirroring the framework's iterate-until-clean loop);
 *  5b/5d. extract the PDF's text layer (the pdftotext equivalent) and verify it
 *      ATS-readably: contact details present, no garbled glyphs, and a keyword
 *      coverage table — covered / missing-but-candidate-has-it / genuine gap.
 *      Never stuff keywords; genuine gaps are reported, not hidden.
 *
 * The cover letter is rendered to a simple text PDF for attachment.
 */
@Service
public class CompileVerifyService {

    private static final Logger log = LoggerFactory.getLogger(CompileVerifyService.class);

    private static final String FIX_SYSTEM = """
            You fix LaTeX compile errors. Given a LaTeX document and the compile error,
            return the corrected COMPLETE document. Change as little as possible — fix the
            error, never alter the content's meaning. Output ONLY the LaTeX source.""";

    private final ResumeDocService latexCompiler;
    private final AiService ai;
    private final ObjectMapper mapper = new ObjectMapper();

    public CompileVerifyService(ResumeDocService latexCompiler, AiService ai) {
        this.latexCompiler = latexCompiler;
        this.ai = ai;
    }

    public record Compiled(byte[] pdf, String latex, String note) {}

    /** 5a + 5c: compile; on a LaTeX error, one AI repair attempt, then retry once. */
    public Compiled compileCv(String latex) {
        try {
            return new Compiled(latexCompiler.compileLatex(latex), latex, "compiled clean");
        } catch (RuntimeException first) {
            log.warn("CV compile failed ({}); attempting one AI repair", first.getMessage());
            try {
                String fixed = ai.complete(FIX_SYSTEM,
                        "COMPILE ERROR:\n" + first.getMessage()
                                + "\n\nDOCUMENT:\n" + latex + "\n\nCorrected document:", false, false);
                fixed = fixed.trim();
                if (fixed.startsWith("```")) {
                    fixed = fixed.replaceAll("(?s)^```(latex|tex)?\\s*", "").replaceAll("```\\s*$", "").trim();
                }
                int dc = fixed.indexOf("\\documentclass");
                if (dc > 0) fixed = fixed.substring(dc);
                byte[] pdf = latexCompiler.compileLatex(fixed);
                return new Compiled(pdf, fixed, "compiled after one repair (" + first.getMessage() + ")");
            } catch (Exception second) {
                throw new IllegalStateException("CV compile failed even after repair: "
                        + second.getMessage() + " [original: " + first.getMessage() + "]");
            }
        }
    }

    public byte[] coverPdf(String coverLetter) {
        return PdfUtil.textToPdf(coverLetter);
    }

    /** 5d: the ATS report. Returns JSON for the dashboard; throws nothing — verification is advisory. */
    public String verify(byte[] cvPdf, Profile profile,
                         List<String> requiredKeywords, List<String> preferredKeywords) {
        ObjectNode report = mapper.createObjectNode();
        String text;
        try (PDDocument doc = Loader.loadPDF(cvPdf)) {
            text = new PDFTextStripper().getText(doc);
            report.put("pages", doc.getNumberOfPages());
        } catch (Exception e) {
            report.put("ok", false);
            report.put("error", "text layer extraction failed: " + e.getMessage());
            return report.toString();
        }
        String low = text.toLowerCase(Locale.ROOT);

        // Contact details present in the text layer (an ATS must be able to reach the candidate).
        boolean hasEmail = profile.getEmail() != null && !profile.getEmail().isBlank()
                && low.contains(profile.getEmail().toLowerCase(Locale.ROOT));
        boolean hasPhone = profile.getPhone() != null
                && digits(text).contains(digits(profile.getPhone()));
        report.put("hasEmail", hasEmail);
        report.put("hasPhone", hasPhone);

        // Garbled-glyph heuristic: replacement chars or a high non-ASCII ratio.
        long weird = text.chars().filter(c -> c == 0xFFFD || (c > 0x2500 && c < 0x2FFF)).count();
        long nonAscii = text.chars().filter(c -> c > 127).count();
        boolean garbled = weird > 0 || (text.length() > 200 && nonAscii * 10 > text.length());
        report.put("garbled", garbled);

        // Keyword coverage: covered / missing-but-have (in profile skills) / genuine gap.
        List<String> skills = profile.getSkills() == null ? List.of()
                : profile.getSkills().stream().map(s -> s.toLowerCase(Locale.ROOT).trim()).toList();
        ArrayNode covered = mapper.createArrayNode();
        ArrayNode missingHave = mapper.createArrayNode();
        ArrayNode missingGap = mapper.createArrayNode();
        int requiredCovered = 0;
        for (String kw : dedup(requiredKeywords)) {
            if (low.contains(kw.toLowerCase(Locale.ROOT))) {
                covered.add(kw);
                requiredCovered++;
            } else if (skills.stream().anyMatch(s -> s.contains(kw.toLowerCase(Locale.ROOT))
                    || kw.toLowerCase(Locale.ROOT).contains(s))) {
                missingHave.add(kw); // candidate has it — the CV just doesn't say it
            } else {
                missingGap.add(kw);  // honest gap — never stuffed
            }
        }
        ArrayNode preferredCovered = mapper.createArrayNode();
        ArrayNode preferredMissing = mapper.createArrayNode();
        for (String kw : dedup(preferredKeywords)) {
            if (low.contains(kw.toLowerCase(Locale.ROOT))) preferredCovered.add(kw);
            else preferredMissing.add(kw);
        }
        int totalRequired = dedup(requiredKeywords).size();
        report.set("requiredCovered", covered);
        report.set("requiredMissingHave", missingHave);
        report.set("requiredMissingGap", missingGap);
        report.set("preferredCovered", preferredCovered);
        report.set("preferredMissing", preferredMissing);
        report.put("requiredCoveragePct",
                totalRequired == 0 ? 100 : Math.round(requiredCovered * 100f / totalRequired));
        report.put("ok", !garbled && (hasEmail || hasPhone));
        return report.toString();
    }

    private static List<String> dedup(List<String> in) {
        return in == null ? List.of() : in.stream().filter(s -> s != null && !s.isBlank())
                .map(String::trim).distinct().limit(25).toList();
    }

    private static String digits(String s) {
        return s == null ? "" : s.replaceAll("\\D", "");
    }
}
