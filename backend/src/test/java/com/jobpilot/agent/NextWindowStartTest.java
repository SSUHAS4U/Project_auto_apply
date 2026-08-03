package com.jobpilot.agent;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

/**
 * The "Next run" line on the LinkedIn / Indeed pages is a promise about when the automation will
 * act, so it has to agree with the rotation that actually starts runs — including the guard that
 * stops a block firing twice in the same window.
 */
class NextWindowStartTest {

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");
    private static final UUID USER = UUID.randomUUID();

    private AgentRunRepository runs;
    private AgentScheduleRepository schedules;
    private AgentService agent;

    @BeforeEach
    void setUp() {
        runs = Mockito.mock(AgentRunRepository.class);
        schedules = Mockito.mock(AgentScheduleRepository.class);
        agent = new AgentService(runs, Mockito.mock(AgentEventRepository.class), schedules,
                Mockito.mock(LiveFrameService.class), Mockito.mock(com.jobpilot.service.SettingsService.class),
                Mockito.mock(com.jobpilot.service.ProfileService.class),
                Mockito.mock(com.jobpilot.service.KeywordMatchScorer.class),
                Mockito.mock(PortalContactRepository.class), Mockito.mock(AgentMessageRepository.class),
                Mockito.mock(PortalConnectionRepository.class),
                Mockito.mock(com.jobpilot.service.ai.AiService.class),
                Mockito.mock(com.jobpilot.engine.EngineProfileRepository.class),
                Mockito.mock(com.jobpilot.service.NotificationService.class),
                Mockito.mock(com.jobpilot.service.MailService.class),
                Mockito.mock(com.jobpilot.repository.ProfileRepository.class),
                Mockito.mock(com.jobpilot.repository.ApplicationRepository.class));
        // Default: this block has NOT run yet in the current window.
        when(runs.existsByUserIdAndPortalAndCreatedAtGreaterThanEqual(any(), any(), any())).thenReturn(false);
    }

    private AgentSchedule block(String portal, String start, int mins, boolean enabled) {
        AgentSchedule b = new AgentSchedule();
        b.setUserId(USER);
        b.setPortal(portal);
        b.setStartTime(start);
        b.setDurationMins(mins);
        b.setEnabled(enabled);
        return b;
    }

    private void given(AgentSchedule... blocks) {
        when(schedules.findByUserIdOrderByOrdAsc(eq(USER))).thenReturn(List.of(blocks));
    }

    /** An instant at HH:mm today, Indian time — the zone the rotation runs in. */
    private Instant at(int h, int m) {
        return LocalDate.now(IST).atTime(h, m).atZone(IST).toInstant();
    }

    @Test
    void returnsTodaysStartWhenTheWindowIsStillAhead() {
        given(block("linkedin", "18:00", 180, true));
        assertEquals(at(18, 0), agent.nextWindowStart(USER, "linkedin", at(9, 0)));
    }

    @Test
    void windowOpenAndUnusedIsDueRightNow() {
        given(block("linkedin", "09:00", 180, true));
        Instant now = at(10, 30);
        assertEquals(now, agent.nextWindowStart(USER, "linkedin", now),
                "inside an unused window the run is due immediately");
    }

    @Test
    void windowOpenButAlreadyUsedRollsToTomorrow() {
        given(block("linkedin", "09:00", 180, true));
        // The rotation's once-per-window guard: a run already started at/after 09:00 today.
        when(runs.existsByUserIdAndPortalAndCreatedAtGreaterThanEqual(any(), any(), any())).thenReturn(true);
        assertEquals(at(9, 0).plusSeconds(86400), agent.nextWindowStart(USER, "linkedin", at(10, 30)),
                "a spent window must not keep claiming the run is due now");
    }

    @Test
    void afterTheLastWindowRollsToTomorrow() {
        given(block("linkedin", "09:00", 120, true));
        assertEquals(at(9, 0).plusSeconds(86400), agent.nextWindowStart(USER, "linkedin", at(23, 30)));
    }

    @Test
    void picksTheEarliestOfSeveralBlocks() {
        given(block("linkedin", "20:00", 60, true),
              block("linkedin", "14:00", 60, true),
              block("linkedin", "18:00", 60, true));
        assertEquals(at(14, 0), agent.nextWindowStart(USER, "linkedin", at(9, 0)));
    }

    @Test
    void ignoresOtherPortalsAndDisabledBlocks() {
        given(block("indeed", "10:00", 60, true),        // other portal
              block("linkedin", "11:00", 60, false),     // disabled
              block("linkedin", "16:00", 60, true));     // the only one that counts
        assertEquals(at(16, 0), agent.nextWindowStart(USER, "linkedin", at(9, 0)));
        assertEquals(at(10, 0), agent.nextWindowStart(USER, "indeed", at(9, 0)));
    }

    @Test
    void noUsableBlockReturnsNull() {
        given(block("linkedin", null, 60, true),         // no start time
              block("linkedin", "not-a-time", 60, true), // unparseable
              block("linkedin", "25:00", 60, true),      // out of range — must not throw
              block("indeed", "10:00", 60, true));
        assertNull(agent.nextWindowStart(USER, "linkedin", at(9, 0)));
    }

    @Test
    void emptyScheduleReturnsNull() {
        given();
        assertNull(agent.nextWindowStart(USER, "linkedin", at(9, 0)));
    }

    @Test
    void portalMatchIsCaseInsensitive() {
        given(block("LinkedIn", "16:00", 60, true));
        assertEquals(at(16, 0), agent.nextWindowStart(USER, "linkedin", at(9, 0)));
    }

    /** Midnight boundary: a run due "tomorrow" must be a real future instant, never the past. */
    @Test
    void neverReturnsATimeInThePast() {
        given(block("linkedin", "09:00", 60, true), block("linkedin", "23:00", 30, true));
        for (int h = 0; h < 24; h++) {
            Instant now = at(h, 45);
            Instant next = agent.nextWindowStart(USER, "linkedin", now);
            assertNotNull(next, "hour " + h);
            assertFalse(next.isBefore(now), "hour " + h + " produced a next run in the past: " + next);
        }
    }
}
