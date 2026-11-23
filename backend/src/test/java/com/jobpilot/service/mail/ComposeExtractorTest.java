package com.jobpilot.service.mail;

import com.jobpilot.domain.Profile;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The paste-to-fill rules. A wrong recipient means an application lands in a stranger's inbox,
 * so each rule is pinned on the shapes real posts use — and on the near-misses that must NOT
 * match ("salary subject to change", a chat timestamp under a phone number).
 */
class ComposeExtractorTest {

    /** The post from the owner's screenshot: WhatsApp-forwarded, timestamp on the last line. */
    private static final String SCREENSHOT_POST = """
            What We're Looking For:
            . Strong technical knowledge and problem-solving skills, passion
            for learning/innovation, and collaborative team spirit.

            How to Apply:
            Email: hr.ops@bluechipfinance.co | Contact: 8796166228
            470 14:01""";

    // ---- email ----

    @Test
    void emailFromTheScreenshotPost() {
        assertEquals(List.of("hr.ops@bluechipfinance.co"), ComposeExtractor.emails(SCREENSHOT_POST));
    }

    @Test
    void emailsAreDistinctInOrderAndDropTrailingDots() {
        String t = "Send CV to Jobs@Acme.com. Queries: info@acme.com; again jobs@acme.com.";
        assertEquals(List.of("Jobs@Acme.com", "info@acme.com"), ComposeExtractor.emails(t));
    }

    @Test
    void placeholderAddressesAreIgnored() {
        assertEquals(List.of(), ComposeExtractor.emails("Write to name@example.com or yourname@gmail.com"));
    }

    @Test
    void noEmailEmptyOrNull() {
        assertEquals(List.of(), ComposeExtractor.emails("Apply on our careers page."));
        assertEquals(List.of(), ComposeExtractor.emails(""));
        assertEquals(List.of(), ComposeExtractor.emails(null));
    }

    // ---- subject ----

    @Test
    void subjectAfterColon() {
        assertEquals("Application for Java Developer - <Your Name>",
                ComposeExtractor.subject("Email: a@b.co\nSubject: Application for Java Developer - <Your Name>\nThanks"));
    }

    @Test
    void subjectLineWithDash() {
        assertEquals("SDE-1 Fresher 2025", ComposeExtractor.subject("Mail with Subject line - SDE-1 Fresher 2025."));
    }

    @Test
    void quotedSubjectMidSentence() {
        assertEquals("Applying for React Intern",
                ComposeExtractor.subject("Please mention \"Applying for React Intern\" in the subject of your mail."));
        assertEquals("Backend_2025_Name",
                ComposeExtractor.subject("Use the subject line ‘Backend_2025_Name’ when you apply"));
        assertEquals("Data Analyst Application",
                ComposeExtractor.subject("with subject as 'Data Analyst Application' to hr@x.com"));
    }

    @Test
    void apostropheIsNotAQuote() {
        // "candidate's" must not open a quote that swallows the rest of the line.
        assertNull(ComposeExtractor.subject("The subject should state the candidate's name and role"));
    }

    @Test
    void wordSubjectWithoutAnInstructionIsNotASubject() {
        assertNull(ComposeExtractor.subject("Salary: subject to change based on experience"));
        assertNull(ComposeExtractor.subject("Looking for a Subject Matter Expert in Java"));
        assertNull(ComposeExtractor.subject(SCREENSHOT_POST));
        assertNull(ComposeExtractor.subject(null));
    }

    @Test
    void placeholdersAreFilledAndUnknownOnesKept() {
        assertEquals("Application for Java Developer - S Suhas",
                ComposeExtractor.fillPlaceholders("Application for <Position> - [Your Name]", "S Suhas", "Java Developer", "Acme"));
        assertEquals("Acme | S Suhas | [Experience]",
                ComposeExtractor.fillPlaceholders("{Company Name} | Your Name | [Experience]", "S Suhas", "Dev", "Acme"));
        // No role known: the placeholder stays so the user sees it and fills it in.
        assertEquals("Application for [Role]", ComposeExtractor.fillPlaceholders("Application for [Role]", "A", null, null));
        assertNull(ComposeExtractor.fillPlaceholders(null, "A", "B", "C"));
    }

    // ---- phone ----

    @Test
    void phoneFromTheScreenshotIgnoresTheTimestampLine() {
        assertEquals(List.of("8796166228"), ComposeExtractor.phones(SCREENSHOT_POST));
    }

    @Test
    void whatsappLineIsPreferredThenMobileNumbers() {
        String t = "Office: 080-41234567\nCall 98450 12345\nWhatsApp: +91 87961 66228";
        assertEquals(List.of("+918796166228", "9845012345", "08041234567"), ComposeExtractor.phones(t));
    }

    @Test
    void datesSalariesAndPincodesAreNotPhones() {
        assertEquals(List.of(), ComposeExtractor.phones("Batch 2024-2025, CTC 4,50,000, PIN 560001, on 12-05-2025"));
        assertEquals(List.of(), ComposeExtractor.phones(null));
    }

    @Test
    void normalizePhone() {
        assertEquals("918796166228", ComposeExtractor.normalizePhone("8796166228", "+91"));
        assertEquals("918796166228", ComposeExtractor.normalizePhone("08796166228", "91"));
        assertEquals("918796166228", ComposeExtractor.normalizePhone("+91 87961-66228", "91"));
        assertEquals("918796166228", ComposeExtractor.normalizePhone("0091 8796166228", "91"));
        assertEquals("918796166228", ComposeExtractor.normalizePhone("918796166228", "91"));
        assertEquals("14155552671", ComposeExtractor.normalizePhone("+1 (415) 555-2671", "91"));
        assertNull(ComposeExtractor.normalizePhone("12345", "91"));
        assertNull(ComposeExtractor.normalizePhone("+1234567890123456", "91")); // 16 digits > E.164
        assertNull(ComposeExtractor.normalizePhone("", "91"));
        assertNull(ComposeExtractor.normalizePhone(null, "91"));
    }

    // ---- role / company ----

    @Test
    void labelledRoleAndCompany() {
        String t = "Company Name: EdHike Pvt Ltd\nRole: Software Developer\nLocation: Pune";
        assertEquals("Software Developer", ComposeExtractor.role(t));
        assertEquals("EdHike Pvt Ltd", ComposeExtractor.company(t));
    }

    @Test
    void hiringForCapturesOnlyTheTitle() {
        assertEquals("Java Full Stack Developer", ComposeExtractor.role("We are hiring a Java Full Stack Developer for our Pune office"));
        assertEquals("Software Engineer", ComposeExtractor.role("Hiring Freshers for Software Engineers!"));
        assertNull(ComposeExtractor.role("we are hiring for multiple positions including developers"));
        assertNull(ComposeExtractor.company("no labels here"));
        assertNull(ComposeExtractor.role(null));
    }

    @Test
    void domainStem() {
        assertEquals("bluechipfinance", ComposeExtractor.domainStem("hr.ops@bluechipfinance.co"));
        assertEquals("acme", ComposeExtractor.domainStem("x@acme.co.in"));
        assertEquals("acme", ComposeExtractor.domainStem("x@careers.acme.com"));
        assertNull(ComposeExtractor.domainStem("someone@gmail.com"));
        assertNull(ComposeExtractor.domainStem("not-an-email"));
        assertNull(ComposeExtractor.domainStem(null));
    }

    @Test
    void appearsInIgnoresCaseAndSpacing() {
        assertTrue(ComposeExtractor.appearsIn("Application  for SDE", "please use APPLICATION FOR\nSDE as subject"));
        assertFalse(ComposeExtractor.appearsIn("Invented subject", SCREENSHOT_POST));
        assertFalse(ComposeExtractor.appearsIn("", "x"));
    }

    // ---- the WhatsApp fallback message ----

    @Test
    void defaultWhatsappIsCompleteWithAndWithoutProfileData() {
        Profile p = new Profile();
        p.setFullName("S Suhas");
        p.setHeadline("B.Tech CSE graduate, ex-Nokia intern");
        String msg = ComposeService.defaultWhatsapp(p, "Software Developer", "EdHike");
        assertTrue(msg.contains("I'm S Suhas, B.Tech CSE graduate, ex-Nokia intern."), msg);
        assertTrue(msg.contains("Software Developer role at EdHike"), msg);
        assertTrue(msg.endsWith("Thank you,\nS Suhas"), msg);
        assertFalse(msg.contains("http"), "links are appended separately, never by the template");

        String bare = ComposeService.defaultWhatsapp(new Profile(), null, null);
        assertTrue(bare.contains("I'd like to apply for the open role."), bare);
        assertTrue(bare.endsWith("Thank you"), bare);
        assertFalse(bare.contains("null"), bare);
    }
}
