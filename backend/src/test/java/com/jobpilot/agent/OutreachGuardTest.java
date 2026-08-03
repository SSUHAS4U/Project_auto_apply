package com.jobpilot.agent;

import com.jobpilot.service.SettingsService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * These limits are what stand between the automation and a restricted LinkedIn account, so each
 * one is pinned explicitly — including the fail-closed behaviour when the database refuses a
 * duplicate that slipped past the read.
 */
class OutreachGuardTest {

    private static final UUID USER = UUID.randomUUID();
    private OutreachLogRepository logs;
    private OutreachGuard guard;

    @BeforeEach
    void setUp() {
        logs = Mockito.mock(OutreachLogRepository.class);
        SettingsService settings = Mockito.mock(SettingsService.class);
        when(settings.get(anyString())).thenReturn(Optional.empty());   // defaults: 3/company/day, 7d, 20/day
        guard = new OutreachGuard(logs, settings);

        when(logs.existsByUserIdAndOutreachHash(any(), anyString())).thenReturn(false);
        when(logs.countByUserIdAndCompanyAndCreatedAtGreaterThanEqual(any(), any(), any())).thenReturn(0L);
        when(logs.countByUserIdAndRecruiterUrlAndCreatedAtGreaterThanEqual(any(), any(), any())).thenReturn(0L);
        when(logs.countByUserIdAndCreatedAtGreaterThanEqual(any(), any())).thenReturn(0L);
    }

    private Map<String, Object> claim() {
        return guard.claim(USER, "linkedin", "Acme", "Java Developer",
                "https://www.linkedin.com/in/jane", "Jane", "resume-v1.pdf");
    }

    @Test
    void allowsAFreshContactAndRecordsIt() {
        Map<String, Object> r = claim();
        assertEquals(true, r.get("ok"), String.valueOf(r.get("reason")));
        verify(logs).saveAndFlush(any(OutreachLog.class));
    }

    @Test
    void blocksAnExactRepeat() {
        when(logs.existsByUserIdAndOutreachHash(any(), anyString())).thenReturn(true);
        Map<String, Object> r = claim();
        assertEquals(false, r.get("ok"));
        assertTrue(String.valueOf(r.get("reason")).contains("already contacted"));
        verify(logs, never()).saveAndFlush(any());
    }

    @Test
    void blocksTheSamePersonInsideTheCooldown() {
        when(logs.countByUserIdAndRecruiterUrlAndCreatedAtGreaterThanEqual(any(), any(), any())).thenReturn(1L);
        Map<String, Object> r = claim();
        assertEquals(false, r.get("ok"));
        assertTrue(String.valueOf(r.get("reason")).contains("7 days"), String.valueOf(r.get("reason")));
    }

    @Test
    void blocksAFourthContactAtTheSameCompanyToday() {
        when(logs.countByUserIdAndCompanyAndCreatedAtGreaterThanEqual(any(), any(), any())).thenReturn(3L);
        Map<String, Object> r = claim();
        assertEquals(false, r.get("ok"));
        assertTrue(String.valueOf(r.get("reason")).contains("company"), String.valueOf(r.get("reason")));
    }

    @Test
    void blocksOnceTheDailyTotalIsReached() {
        when(logs.countByUserIdAndCreatedAtGreaterThanEqual(any(), any())).thenReturn(20L);
        Map<String, Object> r = claim();
        assertEquals(false, r.get("ok"));
        assertTrue(String.valueOf(r.get("reason")).contains("daily"), String.valueOf(r.get("reason")));
    }

    @Test
    void aDatabaseDuplicateIsTreatedAsAlreadyContacted() {
        // The unique index is the backstop for a race the read-then-write check can't see.
        when(logs.saveAndFlush(any())).thenThrow(
                new org.springframework.dao.DataIntegrityViolationException("duplicate key"));
        Map<String, Object> r = claim();
        assertEquals(false, r.get("ok"), "a unique-index violation must never be reported as sendable");
        assertTrue(String.valueOf(r.get("reason")).contains("already contacted"));
    }

    @Test
    void refusesWhenThereIsNoProfileUrlToIdentifyThePersonBy() {
        Map<String, Object> r = guard.claim(USER, "linkedin", "Acme", "Java Developer", "  ", "Jane", "v1");
        assertEquals(false, r.get("ok"));
        verify(logs, never()).saveAndFlush(any());
    }

    @Test
    void theHashIgnoresCaseTrailingSlashesAndQueryStrings() {
        // Otherwise the same person reached by a slightly different URL reads as someone new.
        String a = OutreachGuard.hash("acme", "java developer", "https://www.linkedin.com/in/jane", "v1");
        assertEquals(a, OutreachGuard.hash("acme", "java developer", "https://www.linkedin.com/in/jane", "v1"));

        guard.claim(USER, "linkedin", "ACME", "Java Developer", "https://www.linkedin.com/in/Jane/?trk=x", "Jane", "v1");
        org.mockito.ArgumentCaptor<OutreachLog> cap = org.mockito.ArgumentCaptor.forClass(OutreachLog.class);
        verify(logs).saveAndFlush(cap.capture());
        assertEquals(a, cap.getValue().getOutreachHash(),
                "case, a trailing slash and a tracking query must not create a 'new' person");
    }

    @Test
    void aDifferentRoleForTheSamePersonIsADifferentOutreach() {
        String java = OutreachGuard.hash("acme", "java developer", "u", "v1");
        String react = OutreachGuard.hash("acme", "react developer", "u", "v1");
        assertNotEquals(java, react);
    }

    @Test
    void anUpdatedResumeIsADifferentOutreach() {
        assertNotEquals(OutreachGuard.hash("acme", "role", "u", "v1"),
                        OutreachGuard.hash("acme", "role", "u", "v2"));
    }

    @Test
    void limitsAreTunable() {
        SettingsService s = Mockito.mock(SettingsService.class);
        when(s.get("outreach_per_company_day")).thenReturn(Optional.of("1"));
        when(s.get("outreach_per_recruiter_days")).thenReturn(Optional.of("14"));
        when(s.get("outreach_per_day")).thenReturn(Optional.of("50"));
        OutreachGuard g = new OutreachGuard(logs, s);
        assertEquals(1, g.limits().get("perCompanyPerDay"));
        assertEquals(14, g.limits().get("recruiterCooldownDays"));
        assertEquals(50, g.limits().get("perDay"));
    }

    @Test
    void aCooldownOfZeroDisablesOnlyThatCheck() {
        SettingsService s = Mockito.mock(SettingsService.class);
        when(s.get(anyString())).thenReturn(Optional.empty());
        when(s.get("outreach_per_recruiter_days")).thenReturn(Optional.of("0"));
        OutreachGuard g = new OutreachGuard(logs, s);
        when(logs.countByUserIdAndRecruiterUrlAndCreatedAtGreaterThanEqual(any(), any(), any())).thenReturn(5L);
        Map<String, Object> r = g.claim(USER, "linkedin", "Acme", "Role", "https://x/in/a", "A", "v1");
        assertEquals(true, r.get("ok"));
        // The idempotency hash still applies even with the cooldown off.
        when(logs.existsByUserIdAndOutreachHash(any(), anyString())).thenReturn(true);
        assertEquals(false, g.claim(USER, "linkedin", "Acme", "Role", "https://x/in/a", "A", "v1").get("ok"));
    }

    @Test
    void nullFieldsDoNotThrow() {
        assertDoesNotThrow(() -> guard.claim(USER, null, null, null, "https://x/in/a", null, null));
    }

    @Test
    void aBlankCompanyDoesNotTripTheCompanyThrottle() {
        // Otherwise every contact with an unknown company would share one bucket and stop at 3.
        when(logs.countByUserIdAndCompanyAndCreatedAtGreaterThanEqual(any(), any(), any())).thenReturn(99L);
        Map<String, Object> r = guard.claim(USER, "linkedin", "", "Role", "https://x/in/a", "A", "v1");
        assertEquals(true, r.get("ok"), String.valueOf(r.get("reason")));
    }

    @Test
    void theDailyWindowStartsAtMidnightNotTwentyFourHoursAgo() {
        guard.claim(USER, "linkedin", "Acme", "Role", "https://x/in/a", "A", "v1");
        org.mockito.ArgumentCaptor<Instant> since = org.mockito.ArgumentCaptor.forClass(Instant.class);
        verify(logs).countByUserIdAndCreatedAtGreaterThanEqual(any(), since.capture());
        Instant midnightIst = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Kolkata"))
                .atStartOfDay(java.time.ZoneId.of("Asia/Kolkata")).toInstant();
        assertEquals(midnightIst, since.getValue(), "a daily cap should reset at midnight, not roll");
    }
}
