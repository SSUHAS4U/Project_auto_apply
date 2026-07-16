package com.jobpilot.engine;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Renders a lightweight-markdown résumé / cover letter into a clean, professional PDF
 * entirely in-process with PDFBox — no LaTeX and no external compile service, so it never
 * fails on a network/service error the way texlive.net/ytotech did.
 *
 * Supported markdown: {@code # Name}, {@code ## Section}, {@code ### Sub}, {@code - bullet},
 * plain paragraphs, {@code **bold**} inline runs, and blank lines for spacing.
 */
final class DocPdfRenderer {

    private DocPdfRenderer() {}

    private static final PDFont BODY = new PDType1Font(Standard14Fonts.FontName.HELVETICA);
    private static final PDFont BOLD = new PDType1Font(Standard14Fonts.FontName.HELVETICA_BOLD);
    private static final float MARGIN = 52f;
    private static final float ACCENT_R = 0.09f, ACCENT_G = 0.26f, ACCENT_B = 0.36f; // #16425b

    static byte[] render(String markdown) {
        try (PDDocument doc = new PDDocument()) {
            Cursor c = new Cursor(doc);
            boolean firstContentLineAfterName = false;
            for (String raw : (markdown == null ? "" : markdown).replace("\r", "").split("\n", -1)) {
                String line = raw.strip();
                if (line.isEmpty()) { c.gap(5); firstContentLineAfterName = false; continue; }
                if (line.startsWith("# ")) { c.name(clean(line.substring(2))); firstContentLineAfterName = true; }
                else if (line.startsWith("## ")) { c.section(clean(line.substring(3))); firstContentLineAfterName = false; }
                else if (line.startsWith("### ")) { c.subheading(line.substring(4)); firstContentLineAfterName = false; }
                else if (line.startsWith("- ") || line.startsWith("* ")) { c.bullet(line.substring(2)); firstContentLineAfterName = false; }
                else if (firstContentLineAfterName) { c.contact(clean(line)); firstContentLineAfterName = false; }
                else c.paragraph(line);
            }
            c.finish();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            doc.save(out);
            return out.toByteArray();
        } catch (Exception e) {
            throw new IllegalStateException("PDF render failed: " + e.getMessage(), e);
        }
    }

    /** Strip inline markdown emphasis markers for headings/contact where we render plain. */
    private static String clean(String s) {
        return s.replace("**", "").replace("__", "").trim();
    }

    // ---- layout cursor -------------------------------------------------------

    private static final class Cursor {
        final PDDocument doc;
        PDPage page;
        PDPageContentStream cs;
        float y;
        final float pageW = PDRectangle.A4.getWidth();
        final float pageH = PDRectangle.A4.getHeight();
        final float maxW = PDRectangle.A4.getWidth() - 2 * MARGIN;

        Cursor(PDDocument doc) { this.doc = doc; newPage(); }

        void newPage() {
            try {
                if (cs != null) cs.close();
                page = new PDPage(PDRectangle.A4);
                doc.addPage(page);
                cs = new PDPageContentStream(doc, page);
                y = pageH - MARGIN;
            } catch (Exception e) { throw new IllegalStateException(e); }
        }

        void ensure(float needed) { if (y - needed < MARGIN) newPage(); }

        void gap(float h) { y -= h; }

        void finish() { try { if (cs != null) cs.close(); } catch (Exception ignore) { } }

        void name(String text) {
            ensure(26);
            drawPlain(text, BOLD, 20f, MARGIN, y, 0, 0, 0);
            y -= 24;
        }

        void contact(String text) {
            ensure(16);
            drawPlain(text, BODY, 9.5f, MARGIN, y, 0.35f, 0.4f, 0.46f);
            y -= 16;
        }

        void section(String text) {
            ensure(26);
            y -= 8;
            drawPlain(text.toUpperCase(), BOLD, 11.5f, MARGIN, y, ACCENT_R, ACCENT_G, ACCENT_B);
            y -= 5;
            try {
                cs.setStrokingColor(ACCENT_R, ACCENT_G, ACCENT_B);
                cs.setLineWidth(0.8f);
                cs.moveTo(MARGIN, y); cs.lineTo(pageW - MARGIN, y); cs.stroke();
            } catch (Exception ignore) { }
            y -= 12;
        }

        void subheading(String text) {
            ensure(18);
            drawRich(text, 11f, MARGIN, 0);
            y -= 2;
        }

        void bullet(String text) {
            ensure(15);
            drawPlain("•", BODY, 11f, MARGIN + 4, y, 0.2f, 0.2f, 0.2f);
            drawRich(text, 10.5f, MARGIN + 18, 18);
        }

        void paragraph(String text) {
            ensure(15);
            drawRich(text, 10.5f, MARGIN, 0);
        }

        /** Draw a single plain string (no wrapping) — used for headings/contact. */
        void drawPlain(String text, PDFont font, float size, float x, float yy, float r, float g, float b) {
            try {
                cs.beginText();
                cs.setNonStrokingColor(r, g, b);
                cs.setFont(font, size);
                cs.newLineAtOffset(x, yy - size);
                cs.showText(sanitize(text));
                cs.endText();
            } catch (Exception ignore) { }
        }

        /** Word-wrap a line that may contain **bold** runs, drawing across pages. */
        void drawRich(String text, float size, float x, float hangingIndent) {
            List<Seg> segs = parse(text);
            float lineH = size + 3.5f;
            float cursorX = x;
            float lineTop = y;
            boolean started = false;
            for (Seg seg : segs) {
                for (String word : seg.text.split(" ", -1)) {
                    if (word.isEmpty()) continue;
                    PDFont f = seg.bold ? BOLD : BODY;
                    float wWidth = width(f, size, word + " ");
                    if (started && cursorX + wWidth > pageW - MARGIN) {
                        y -= lineH;
                        if (y - lineH < MARGIN) { newPage(); }
                        cursorX = x + hangingIndent;
                        lineTop = y;
                    }
                    drawWord(word + " ", f, size, cursorX, y);
                    cursorX += wWidth;
                    started = true;
                    lineTop = y;
                }
            }
            y = lineTop - lineH;
        }

        void drawWord(String word, PDFont font, float size, float x, float yy) {
            try {
                cs.beginText();
                cs.setNonStrokingColor(0.12f, 0.12f, 0.14f);
                cs.setFont(font, size);
                cs.newLineAtOffset(x, yy - size);
                cs.showText(sanitize(word));
                cs.endText();
            } catch (Exception ignore) { }
        }

        float width(PDFont font, float size, String s) {
            try { return font.getStringWidth(sanitize(s)) / 1000f * size; }
            catch (Exception e) { return s.length() * size * 0.5f; }
        }
    }

    private record Seg(String text, boolean bold) {}

    /** Split a line into normal / **bold** segments. */
    private static List<Seg> parse(String text) {
        List<Seg> segs = new ArrayList<>();
        int i = 0;
        boolean bold = false;
        StringBuilder cur = new StringBuilder();
        while (i < text.length()) {
            if (i + 1 < text.length() && text.charAt(i) == '*' && text.charAt(i + 1) == '*') {
                if (cur.length() > 0) { segs.add(new Seg(cur.toString(), bold)); cur.setLength(0); }
                bold = !bold;
                i += 2;
            } else {
                cur.append(text.charAt(i));
                i++;
            }
        }
        if (cur.length() > 0) segs.add(new Seg(cur.toString(), bold));
        return segs;
    }

    /** Standard-14 Helvetica is WinAnsi — drop anything it can't encode to avoid a hard fail. */
    private static String sanitize(String s) {
        StringBuilder b = new StringBuilder(s.length());
        for (char c : s.toCharArray()) {
            if (c == '•') { b.append(c); continue; }
            if (c >= 0x20 && c <= 0x7E) b.append(c);        // ASCII
            else if (c == '’' || c == '‘') b.append('\'');
            else if (c == '“' || c == '”') b.append('"');
            else if (c == '–' || c == '—') b.append('-');
            else if (c == ' ') b.append(' ');
            // else drop
        }
        return b.toString();
    }
}
