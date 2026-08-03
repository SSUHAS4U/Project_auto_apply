package com.jobpilot.agent;

import com.jobpilot.service.SettingsService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * The trigger is now "the app is open and work is owed", not a clock-time schedule row. This is
 * the bug where a user configured everything correctly and nothing ever started, because the UI
 * said there were no start times to set while the backend still demanded one.
 */
class AutoStartTest {

    private static final UUID USER = UUID.randomUUID();

    private AgentRunRepository runs;
    private AgentEventRepository events;
    private SettingsService settings;
    private AgentService agent;

    @BeforeEach
    void setUp() {
        runs = Mockito.mock(AgentRunRepository.class);
        events = Mockito.mock(AgentEventRepository.class);
        settings = Mockito.mock(SettingsService.class);
        when(settings.get(anyString())).thenReturn(Optional.empty());   // all defaults

        agent = new AgentService(runs, events, Mockito.mock(AgentScheduleRepository.class),
                Mockito.mock(LiveFrameService.class), settings,
                Mockito.mock(com.jobpilot.service.ProfileService.class),
                Mockito.mock(com.jobpilot.service.KeywordMatchScorer.class),
                Mockito.mock(PortalContactRepository.class), Mockito.mock(AgentMessageRepository.class),
                Mockito.mock(PortalConnectionRepository.class), Mockito.mock(com.jobpilot.service.ai.AiService.class),
                Mockito.mock(com.jobpilot.engine.EngineProfileRepository.class),
                Mockito.mock(com.jobpilot.service.NotificationService.class),
                Mockito.mock(com.jobpilot.service.MailService.class),
                Mockito.mock(com.jobpilot.repository.ProfileRepository.class),
                Mockito.mock(com.jobpilot.repository.ApplicationRepository.class));

        // Sensible baseline: nothing applied, nothing running, no history.
        when(events.countAppliedSince(any(), anyString(), any())).thenReturn(0L);
        when(runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(any(), anyString())).thenReturn(Optional.empty());
        when(runs.findFirstByUserIdAndPortalOrderByCreatedAtDesc(any(), anyString())).thenReturn(Optional.empty());
        when(runs.countByUserIdAndPortalAndCreatedAtGreaterThanEqual(any(), anyString(), any())).thenReturn(0L);
        when(runs.findByUserIdOrderByCreatedAtDesc(any(), any())).thenReturn(List.of());
        when(runs.save(any())).thenAnswer(i -> { AgentRun r = i.getArgument(0); r.setId(UUID.randomUUID()); return r; });
    }

    private void desktopOnline() { agent.markWorkerSeen(USER); }

    private AgentRun run(String portal, String status, Instant created, Instant ended) {
        AgentRun r = new AgentRun();
        r.setId(UUID.randomUUID());
        r.setUserId(USER);
        r.setPortal(portal);
        r.setStatus(status);
        r.setCreatedAt(created);
        r.setEndedAt(ended);
        return r;
    }

    @Test
    void startsWithNoScheduleRowAtAll() {
        desktopOnline();
        String result = agent.tickRotationForUser(USER);
        assertTrue(result.startsWith("started "), "expected a run to start, got: " + result);
        verify(runs, atLeastOnce()).save(any());
    }

    @Test
    void doesNotStartWhenTheDesktopAppIsNotRunning() {
        // No markWorkerSeen — queueing a run nothing can pick up just leaves a phantom "queued".
        String result = agent.tickRotationForUser(USER);
        assertTrue(result.toLowerCase().contains("desktop"), result);
        verify(runs, never()).save(any());
    }

    @Test
    void doesNotStartASecondRunWhileOneIsLive() {
        desktopOnline();
        when(runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(USER, "running"))
                .thenReturn(Optional.of(run("linkedin", "running", Instant.now(), null)));
        assertTrue(agent.tickRotationForUser(USER).startsWith("already running"));
        verify(runs, never()).save(any());
    }

    @Test
    void restsBetweenBlocks() {
        desktopOnline();
        // A run ended 5 minutes ago; the default rest is 30.
        when(runs.findByUserIdOrderByCreatedAtDesc(any(), any())).thenReturn(
                List.of(run("indeed", "done", Instant.now().minusSeconds(600), Instant.now().minusSeconds(300))));
        assertTrue(agent.tickRotationForUser(USER).startsWith("resting"), "should wait out the rest window");
        verify(runs, never()).save(any());
    }

    @Test
    void startsAgainOnceTheRestWindowHasPassed() {
        desktopOnline();
        when(runs.findByUserIdOrderByCreatedAtDesc(any(), any())).thenReturn(
                List.of(run("indeed", "done", Instant.now().minusSeconds(7200), Instant.now().minusSeconds(3600))));
        assertTrue(agent.tickRotationForUser(USER).startsWith("started "));
    }

    @Test
    void stopsWhenEveryQuotaIsMet() {
        desktopOnline();
        when(events.countAppliedSince(any(), anyString(), any())).thenReturn(20L);   // both caps are 20
        // LinkedIn's outreach allowance is also spent.
        when(runs.countByUserIdAndPortalAndCreatedAtGreaterThanEqual(any(), anyString(), any())).thenReturn(5L);
        assertEquals("all of today's quotas are met", agent.tickRotationForUser(USER));
        verify(runs, never()).save(any());
    }

    @Test
    void linkedinStillRunsForOutreachAfterItsApplyQuotaIsMet() {
        // Its second phase is outreach — stopping dead at 20 applications would silently switch
        // off connections and HR emails for the rest of the day.
        when(events.countAppliedSince(any(), anyString(), any())).thenReturn(20L);
        when(runs.countByUserIdAndPortalAndCreatedAtGreaterThanEqual(any(), eq("linkedin"), any())).thenReturn(0L);
        assertTrue(agent.portalOwesWork(USER, "linkedin", Instant.now()));
        assertFalse(agent.portalOwesWork(USER, "indeed", Instant.now()),
                "Indeed only applies — a met quota means it is done");
    }

    @Test
    void theOutreachAllowanceIsBounded() {
        when(events.countAppliedSince(any(), anyString(), any())).thenReturn(20L);
        when(runs.countByUserIdAndPortalAndCreatedAtGreaterThanEqual(any(), eq("linkedin"), any())).thenReturn(2L);
        assertFalse(agent.portalOwesWork(USER, "linkedin", Instant.now()),
                "must not loop all day once there is nothing left to apply to");
    }

    @Test
    void prefersThePortalThatRanLeastRecently() {
        when(runs.findFirstByUserIdAndPortalOrderByCreatedAtDesc(USER, "linkedin"))
                .thenReturn(Optional.of(run("linkedin", "done", Instant.now().minusSeconds(600), null)));
        when(runs.findFirstByUserIdAndPortalOrderByCreatedAtDesc(USER, "indeed"))
                .thenReturn(Optional.of(run("indeed", "done", Instant.now().minusSeconds(7200), null)));
        assertEquals("indeed", agent.nextPortalWithWork(USER), "the older one should go next");
    }

    @Test
    void aPortalThatHasNeverRunGoesFirst() {
        when(runs.findFirstByUserIdAndPortalOrderByCreatedAtDesc(USER, "linkedin"))
                .thenReturn(Optional.of(run("linkedin", "done", Instant.now().minusSeconds(60), null)));
        when(runs.findFirstByUserIdAndPortalOrderByCreatedAtDesc(USER, "indeed")).thenReturn(Optional.empty());
        assertEquals("indeed", agent.nextPortalWithWork(USER));
    }

    @Test
    void nextRunIsDueNowWhenWorkIsOwedAndNothingIsResting() {
        desktopOnline();
        Instant now = Instant.now();
        assertEquals(now, agent.nextWindowStart(USER, "linkedin", now));
    }

    @Test
    void nextRunIsTheEndOfTheRestWindowWhileResting() {
        desktopOnline();
        Instant ended = Instant.now().minusSeconds(300);
        when(runs.findByUserIdOrderByCreatedAtDesc(any(), any())).thenReturn(
                List.of(run("indeed", "done", ended.minusSeconds(600), ended)));
        Instant next = agent.nextWindowStart(USER, "linkedin", Instant.now());
        assertNotNull(next);
        assertEquals(ended.plusSeconds(30 * 60L), next);
    }

    @Test
    void nextRunIsNullWhenTheDesktopAppIsClosed() {
        // Nothing is coming at all — saying "in 5 minutes" would be a lie.
        assertNull(agent.nextWindowStart(USER, "linkedin", Instant.now()));
    }

    @Test
    void nextRunRollsToTomorrowOnceTheQuotaIsMet() {
        desktopOnline();
        when(events.countAppliedSince(any(), anyString(), any())).thenReturn(20L);
        when(runs.countByUserIdAndPortalAndCreatedAtGreaterThanEqual(any(), anyString(), any())).thenReturn(9L);
        Instant next = agent.nextWindowStart(USER, "indeed", Instant.now());
        assertNotNull(next);
        assertTrue(next.isAfter(Instant.now()), "tomorrow's reset must be in the future");
    }
}
