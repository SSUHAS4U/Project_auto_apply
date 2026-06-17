package com.jobpilot;

import com.jobpilot.connector.RawJob;
import com.jobpilot.service.NormalizeService;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class NormalizeServiceTest {

    private final NormalizeService svc = new NormalizeService();

    @Test
    void contentHashIsStableAndCaseInsensitive() {
        String a = svc.contentHash("Acme Inc", "Backend Engineer", "Bengaluru");
        String b = svc.contentHash("  acme inc ", "backend engineer", "BENGALURU");
        assertEquals(a, b, "hash should normalize case/whitespace");
        assertEquals(64, a.length(), "sha-256 hex is 64 chars");
    }

    @Test
    void contentHashDiffersOnDifferentJobs() {
        assertNotEquals(
                svc.contentHash("Acme", "Backend Engineer", "Pune"),
                svc.contentHash("Acme", "Frontend Engineer", "Pune"));
    }

    @Test
    void atsApplyTypeIsPreserved() {
        RawJob r = RawJob.builder().applyType("ats").title("X").url("u").build();
        assertEquals("ats", svc.classify(r).type());
    }

    @Test
    void emailIsDetectedFromDescription() {
        RawJob r = RawJob.builder().applyType("url")
                .description("Send your CV to careers@startup.io to apply.").build();
        NormalizeService.ApplyClassification c = svc.classify(r);
        assertEquals("email", c.type());
        assertEquals("careers@startup.io", c.email());
    }

    @Test
    void noreplyEmailIsIgnored() {
        RawJob r = RawJob.builder().applyType("url")
                .description("Auto mail from no-reply@jobs.com only.").build();
        assertEquals("url", svc.classify(r).type());
    }

    @Test
    void unknownCollapsesToUrl() {
        RawJob r = RawJob.builder().applyType("unknown").build();
        assertEquals("url", svc.classify(r).type());
    }
}
