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
        // Quota met, and the day's outreach-only blocks are spent. The ceiling comes from
        // settings (default 3), so this asserts the BOUND exists rather than a magic number.
        when(events.countAppliedSince(any(), anyString(), any())).thenReturn(20L);
        int ceiling = (int) agent.limits().get("outreachBlocksPerDay");
        when(runs.countByUserIdAndPortalAndCreatedAtGreaterThanEqual(any(), eq("linkedin"), any()))
                .thenReturn((long) ceiling);
        assertFalse(agent.portalOwesWork(USER, "linkedin", Instant.now()),
                "must not loop all day once there is nothing left to apply to");
    }

    @Test
    void outreachBlocksAreStillAllowedBelowTheCeiling() {
        // Apply quota met but outreach blocks remain — LinkedIn must STILL run, or connections
        // and HR emails silently stop for the rest of the day.
        when(events.countAppliedSince(any(), anyString(), any())).thenReturn(20L);
        when(runs.countByUserIdAndPortalAndCreatedAtGreaterThanEqual(any(), eq("linkedin"), any())).thenReturn(0L);
        assertTrue(agent.portalOwesWork(USER, "linkedin", Instant.now()),
                "outreach is the whole point of the extra blocks");
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

    // ---- "next run" must differ per portal -----------------------------------
    // The card showed an IDENTICAL next-run time for LinkedIn and Indeed, because the rest
    // window is global. Only one portal actually starts next; the other has no honest time.

    @Test
    void onlyThePortalThatIsActuallyNextGetsATime() {
        desktopOnline();
        // LinkedIn ran an hour ago, Indeed two hours ago → Indeed goes first.
        when(runs.findFirstByUserIdAndPortalOrderByCreatedAtDesc(USER, "linkedin"))
                .thenReturn(Optional.of(run("linkedin", "done", Instant.now().minusSeconds(3600), null)));
        when(runs.findFirstByUserIdAndPortalOrderByCreatedAtDesc(USER, "indeed"))
                .thenReturn(Optional.of(run("indeed", "done", Instant.now().minusSeconds(7200), null)));

        Instant now = Instant.now();
        Instant indeed = agent.nextWindowStart(USER, "indeed", now);
        Instant linkedin = agent.nextWindowStart(USER, "linkedin", now);

        assertNotNull(indeed, "the portal that runs next must give a time");
        assertNull(linkedin, "the portal that follows cannot know when — it must not invent one");
        assertNotEquals(indeed, linkedin, "the two portals must never show the same next-run time");
    }

    @Test
    void theRestWindowStillDelaysThePortalThatIsNext() {
        desktopOnline();
        Instant endedAt = Instant.now().minusSeconds(300);          // 5 min ago; rest is 30
        when(runs.findByUserIdOrderByCreatedAtDesc(any(), any()))
                .thenReturn(List.of(run("indeed", "done", Instant.now().minusSeconds(600), endedAt)));
        Instant next = agent.nextWindowStart(USER, agent.nextPortalWithWork(USER), Instant.now());
        assertNotNull(next);
        assertTrue(next.isAfter(Instant.now()), "must wait out the rest window");
        assertTrue(next.isBefore(endedAt.plusSeconds(31 * 60)), "and not longer than the rest window");
    }

    @Test
    void aMetQuotaReportsTomorrowNotAClockTime() {
        desktopOnline();
        when(events.countAppliedSince(any(), eq("indeed"), any())).thenReturn(20L);
        Instant next = agent.nextWindowStart(USER, "indeed", Instant.now());
        assertNotNull(next, "a met quota still resets tomorrow");
        assertTrue(next.isAfter(Instant.now().plusSeconds(60)), "tomorrow, not now");
    }

    @Test
    void nothingIsPromisedWhileTheDesktopIsOffline() {
        // No markWorkerSeen. A time here would be a promise nothing can keep.
        assertNull(agent.nextWindowStart(USER, "linkedin", Instant.now()));
        assertNull(agent.nextWindowStart(USER, "indeed", Instant.now()));
    }

    // ---- abandoned runs must not block the rotation forever --------------------
    // Only the worker advances a run. If the app is closed/killed/slept, the row stays
    // "running" and tickRotationForUser refuses to start ANYTHING — including the other
    // portal. This is the silent failure that made Indeed look like it never worked.

    /**
     * A run from an old session with the worker long gone — INCLUDING the heartbeat history a
     * real one would have left. Without that the scenario is "a backend that has never heard
     * from this worker", which must NOT reap (a deploy looks exactly like that).
     */
    private void abandonedRun(String portal) {
        agent.markWorkerSeen(USER);
        setLastSeen(USER, Instant.now().minusSeconds(30 * 60));
        when(runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(USER, "running"))
                .thenReturn(Optional.of(run(portal, "running", Instant.now().minusSeconds(6 * 3600), null)));
    }

    @Test
    void anAbandonedRunIsEndedSoTheRotationCanMoveOn() {
        abandonedRun("linkedin");
        assertEquals(1, agent.reapStaleRuns(USER), "the stuck run should be ended");
        verify(runs).save(argThat(r -> "failed".equals(r.getStatus()) && r.getEndedAt() != null));
    }

    @Test
    void aLiveRunWithAWorkerBehindItIsNeverReaped() {
        // Set the run up first, THEN mark the worker live — abandonedRun() backdates the
        // heartbeat, which is the opposite of what this case is about.
        when(runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(USER, "running"))
                .thenReturn(Optional.of(run("linkedin", "running", Instant.now().minusSeconds(6 * 3600), null)));
        desktopOnline();                       // worker pinged just now
        assertEquals(0, agent.reapStaleRuns(USER), "a run with a live worker must be left alone");
        verify(runs, never()).save(any());
    }

    @Test
    void aRecentRunIsNotReapedEvenWhenTheWorkerIsQuiet() {
        // Started 30s ago. Too soon to call it abandoned — the worker may be mid-navigation.
        when(runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(USER, "running"))
                .thenReturn(Optional.of(run("indeed", "running", Instant.now().minusSeconds(30), null)));
        assertEquals(0, agent.reapStaleRuns(USER));
        verify(runs, never()).save(any());
    }

    @Test
    void aBackendRestartDoesNotReapARunItHasSimplyNotSeenYet() {
        // lastWorkerSeen is in-memory and empty after a restart. A run that started seconds ago
        // must survive; the worker re-registers within a few seconds.
        when(runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(USER, "running"))
                .thenReturn(Optional.of(run("linkedin", "running", Instant.now().minusSeconds(5), null)));
        assertEquals(0, agent.reapStaleRuns(USER));
    }

    @Test
    void reapingUnblocksTheOtherPortal() {
        // The whole point: after an abandoned LinkedIn run is cleared, Indeed can finally run.
        abandonedRun("linkedin");
        agent.reapStaleRuns(USER);
        // The stuck row is gone from the live set now.
        when(runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(any(), anyString())).thenReturn(Optional.empty());
        desktopOnline();
        String result = agent.tickRotationForUser(USER);
        assertTrue(result.startsWith("started "), "expected a run to start, got: " + result);
    }

    // ---- the reaper must not kill a HEALTHY run -------------------------------
    // lastWorkerSeen is in-memory, so a backend deploy empties it. Treating "no heartbeat
    // recorded" as "the worker is gone" marked a live run failed; /next then returned idle,
    // the worker's poller saw its run vanish and silently broke every loop in the block.
    // That is the bug that made BOTH portals produce a header, a summary, and nothing between.

    @Test
    void aFreshBackendDoesNotReapARunItHasNeverHeardAbout() {
        // No markWorkerSeen at all — exactly the state after a deploy. The run is 6 hours old,
        // which the old guard treated as reapable.
        when(runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(USER, "running"))
                .thenReturn(Optional.of(run("linkedin", "running", Instant.now().minusSeconds(6 * 3600), null)));
        assertEquals(0, agent.reapStaleRuns(USER),
                "a just-started backend must not judge a run by a heartbeat map it hasn't filled yet");
        verify(runs, never()).save(any());
    }

    @Test
    void aRunIsStillReapedOnceWeHaveHeardFromTheWorkerAndThenLostIt() {
        // The legitimate case: the worker checked in, then went away for longer than the cutoff.
        agent.markWorkerSeen(USER);
        setLastSeen(USER, Instant.now().minusSeconds(30 * 60));
        when(runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(USER, "running"))
                .thenReturn(Optional.of(run("linkedin", "running", Instant.now().minusSeconds(6 * 3600), null)));
        assertEquals(1, agent.reapStaleRuns(USER), "a genuinely abandoned run must still be ended");
    }

    @Test
    void aLiveWorkerIsNeverReapedWhateverTheRunAge() {
        desktopOnline();
        when(runs.findFirstByUserIdAndStatusOrderByCreatedAtDesc(USER, "running"))
                .thenReturn(Optional.of(run("linkedin", "running", Instant.now().minusSeconds(24 * 3600), null)));
        assertEquals(0, agent.reapStaleRuns(USER));
        verify(runs, never()).save(any());
    }

    /** Backdate the in-memory heartbeat, the way real time passing would. */
    private void setLastSeen(UUID user, Instant when) {
        try {
            java.lang.reflect.Field f = AgentService.class.getDeclaredField("lastWorkerSeen");
            f.setAccessible(true);
            @SuppressWarnings("unchecked")
            java.util.Map<UUID, Instant> m = (java.util.Map<UUID, Instant>) f.get(agent);
            m.put(user, when);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
