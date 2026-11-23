package com.jobpilot.service.documents;

import com.jobpilot.domain.ResumeDoc;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Uploaded résumés are attached to emails sent in the user's name and served from public share
 * links, so the type is decided by the file's bytes — never by its name or the browser's claim.
 */
class ResumeLibraryTest {

    private static byte[] b(int... v) {
        byte[] out = new byte[v.length];
        for (int i = 0; i < v.length; i++) out[i] = (byte) v[i];
        return out;
    }

    @Test
    void sniffsPdfDocxAndDoc() {
        assertEquals("application/pdf", ResumeDocService.sniffType("%PDF-1.7\n...".getBytes(StandardCharsets.US_ASCII)));
        assertEquals(ResumeDocService.DOCX, ResumeDocService.sniffType(b('P', 'K', 3, 4, 20, 0)));
        assertEquals(ResumeDocService.DOC, ResumeDocService.sniffType(b(0xD0, 0xCF, 0x11, 0xE0, 0xA1)));
    }

    @Test
    void refusesAnythingElse() {
        assertNull(ResumeDocService.sniffType("<html><script>".getBytes(StandardCharsets.US_ASCII)));
        assertNull(ResumeDocService.sniffType(b(0x89, 'P', 'N', 'G')));
        assertNull(ResumeDocService.sniffType(b('P', 'K', 5, 6))); // an empty zip, not a DOCX
        assertNull(ResumeDocService.sniffType(b('%', 'P')));        // too short
        assertNull(ResumeDocService.sniffType(new byte[0]));
        assertNull(ResumeDocService.sniffType(null));
    }

    @Test
    void filenameGetsTheRealExtensionAndNoPathOrHeaderBreakingCharacters() {
        assertEquals("Suhas_Java.pdf", ResumeDocService.cleanFilename("Suhas_Java.pdf", "application/pdf"));
        // A PDF renamed .docx is sent as what it is.
        assertEquals("cv.pdf", ResumeDocService.cleanFilename("cv.docx", "application/pdf"));
        assertEquals("resume.docx", ResumeDocService.cleanFilename("C:\\Users\\me\\resume.docx", ResumeDocService.DOCX));
        assertEquals("evil.pdf", ResumeDocService.cleanFilename("../../evil\".pdf", "application/pdf"));
        assertEquals("resume.doc", ResumeDocService.cleanFilename(null, ResumeDocService.DOC));
        assertEquals("resume.pdf", ResumeDocService.cleanFilename("\"\"\".pdf", "application/pdf"));
        assertEquals(124, ResumeDocService.cleanFilename("x".repeat(500) + ".pdf", "application/pdf").length());
    }

    @Test
    void builtResumeFileIsAPdfNamedAfterTheResume() {
        ResumeDoc d = new ResumeDoc();
        d.setName("Backend – Razorpay");
        d.setPdf(new byte[]{1});
        ResumeDocService.ResumeFile f = ResumeDocService.fileOf(d);
        assertEquals("application/pdf", f.contentType());
        assertEquals("Backend__Razorpay.pdf", f.filename());

        d.setName("—");
        assertEquals("resume.pdf", ResumeDocService.fileOf(d).filename());
    }

    @Test
    void uploadedResumeKeepsItsFilenameAndType() {
        ResumeDoc d = new ResumeDoc();
        d.setName("Java");
        d.setSource(ResumeDoc.SOURCE_UPLOADED);
        d.setFilename("Suhas_Java.docx");
        d.setContentType(ResumeDocService.DOCX);
        d.setPdf(new byte[]{1});
        ResumeDocService.ResumeFile f = ResumeDocService.fileOf(d);
        assertEquals("Suhas_Java.docx", f.filename());
        assertEquals(ResumeDocService.DOCX, f.contentType());
        assertTrue(d.isUploaded());
        assertFalse(new ResumeDoc().isUploaded(), "a new row is a built résumé by default");
    }
}
