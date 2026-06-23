package com.jobpilot.service;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Tiny dependency-free text → PDF generator (Helvetica, word-wrapped, multi-page).
 * Good enough for cover letters / simple documents without pulling in a PDF library.
 */
public final class PdfUtil {

    private PdfUtil() {}

    private static final int LINES_PER_PAGE = 48;
    private static final int WRAP = 92;

    public static byte[] textToPdf(String text) {
        List<String> lines = wrap(text == null ? "" : text);
        List<List<String>> pages = paginate(lines);

        // Build content streams + page objects. Object layout:
        // 1 Catalog, 2 Pages, 3 Font, then per page: a Page obj and a Contents obj.
        List<String> objs = new ArrayList<>();
        StringBuilder kids = new StringBuilder();
        int firstPageObj = 4; // 1=catalog,2=pages,3=font
        int objIndex = firstPageObj;
        List<String> pageObjs = new ArrayList<>();
        List<String> contentObjs = new ArrayList<>();
        for (List<String> page : pages) {
            int pageObjNum = objIndex++;
            int contentObjNum = objIndex++;
            kids.append(pageObjNum).append(" 0 R ");
            pageObjs.add("<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents "
                    + contentObjNum + " 0 R>>");
            StringBuilder body = new StringBuilder("BT /F1 11 Tf 64 760 Td 15 TL\n");
            for (String l : page) body.append('(').append(esc(l)).append(") Tj T*\n");
            body.append("ET");
            contentObjs.add("<</Length " + body.length() + ">>\nstream\n" + body + "\nendstream");
        }

        objs.add("<</Type/Catalog/Pages 2 0 R>>");
        objs.add("<</Type/Pages/Kids[" + kids.toString().trim() + "]/Count " + pages.size() + ">>");
        objs.add("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
        // interleave page + content objects in the same order numbers were assigned
        for (int i = 0; i < pageObjs.size(); i++) { objs.add(pageObjs.get(i)); objs.add(contentObjs.get(i)); }

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        StringBuilder pdf = new StringBuilder("%PDF-1.4\n");
        int[] offsets = new int[objs.size()];
        for (int i = 0; i < objs.size(); i++) {
            offsets[i] = pdf.toString().getBytes(StandardCharsets.ISO_8859_1).length;
            pdf.append(i + 1).append(" 0 obj\n").append(objs.get(i)).append("\nendobj\n");
        }
        int xref = pdf.toString().getBytes(StandardCharsets.ISO_8859_1).length;
        pdf.append("xref\n0 ").append(objs.size() + 1).append("\n0000000000 65535 f \n");
        for (int off : offsets) pdf.append(String.format("%010d 00000 n \n", off));
        pdf.append("trailer\n<</Size ").append(objs.size() + 1).append("/Root 1 0 R>>\nstartxref\n").append(xref).append("\n%%EOF");

        out.writeBytes(pdf.toString().getBytes(StandardCharsets.ISO_8859_1));
        return out.toByteArray();
    }

    private static List<String> wrap(String text) {
        List<String> lines = new ArrayList<>();
        for (String para : text.replace("\r", "").split("\n", -1)) {
            if (para.isBlank()) { lines.add(""); continue; }
            StringBuilder cur = new StringBuilder();
            for (String w : para.split("\\s+")) {
                if (cur.length() + 1 + w.length() > WRAP) { lines.add(cur.toString().trim()); cur = new StringBuilder(w); }
                else cur.append(' ').append(w);
            }
            if (!cur.toString().isBlank()) lines.add(cur.toString().trim());
        }
        return lines;
    }

    private static List<List<String>> paginate(List<String> lines) {
        List<List<String>> pages = new ArrayList<>();
        for (int i = 0; i < Math.max(lines.size(), 1); i += LINES_PER_PAGE) {
            pages.add(new ArrayList<>(lines.subList(i, Math.min(i + LINES_PER_PAGE, lines.size()))));
        }
        if (pages.isEmpty()) pages.add(new ArrayList<>());
        return pages;
    }

    private static String esc(String s) {
        StringBuilder b = new StringBuilder();
        for (char c : s.toCharArray()) {
            if (c < 0x20 || c > 0x7E) continue; // keep it ASCII for the base font
            if (c == '(' || c == ')' || c == '\\') b.append('\\');
            b.append(c);
        }
        return b.toString();
    }
}
