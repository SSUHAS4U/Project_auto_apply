package com.jobpilot.agent;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * The cadence sends four messages to someone who accepted a connection, so the rules that stop
 * it becoming nagging — count from the LAST touch, and archive when spent — matter more than the
 * sending itself.
 */
class FollowUpServiceTest {

    private static final UUID USER = UUID.randomUUID();
    private PortalContactRepository contacts;
    private FollowUpService svc;

    @BeforeEach
    void setUp() {
        contacts = Mockito.mock(PortalContactRepository.class);
        // The cadence now reads its spacing from settings, so the service needs the agent.
        // Returning the shipped defaults keeps these tests about the CADENCE, not the config.
        AgentService agent = Mockito.mock(AgentService.class);
        when(agent.limits()).thenReturn(java.util.Map.of(
                "followUp1", 1, "followUp2", 2, "followUp3", 5, "followUp4", 10));
        svc = new FollowUpService(contacts, agent);
        when(contacts.save(any())).thenAnswer(i -> i.getArgument(0));
    }

    /** Spacing comes from settings; a missing or unreadable value must fall back, never crash. */
    @Test
    void spacingFallsBackWhenSettingsAreMissing() {
        AgentService broken = Mockito.mock(AgentService.class);
        when(broken.limits()).thenThrow(new IllegalStateException("settings unavailable"));
        FollowUpService s2 = new FollowUpService(contacts, broken);
        assertArrayEquals(FollowUpService.DEFAULT_GAP_DAYS, s2.gapDays());
    }

    /** A custom cadence is actually honoured, not just stored. */
    @Test
    void customSpacingIsUsed() {
        AgentService custom = Mockito.mock(AgentService.class);
        when(custom.limits()).thenReturn(java.util.Map.of(
                "followUp1", 3, "followUp2", 3, "followUp3", 3, "followUp4", 3));
        FollowUpService s2 = new FollowUpService(contacts, custom);
        assertFalse(s2.isDue(contact(0, daysAgo(2), null), Instant.now()), "2 days < the 3 configured");
        assertTrue(s2.isDue(contact(0, daysAgo(4), null), Instant.now()), "4 days > the 3 configured");
    }

    private PortalContact contact(int stage, Instant lastContact, Instant archived) {
        PortalContact c = new PortalContact();
        c.setId(UUID.randomUUID());
        c.setUserId(USER);
        c.setName("Jane");
        c.setConnectionStatus("connected");
        c.setFollowUpStage(stage);
        c.setLastContactAt(lastContact);
        c.setArchivedAt(archived);
        return c;
    }

    private static Instant daysAgo(double d) {
        return Instant.now().minus(Duration.ofMinutes((long) (d * 24 * 60)));
    }

    @Test
    void theDefaultScheduleIsDayOneTwoFiveTen() {
        assertArrayEquals(new int[] { 1, 2, 5, 10 }, FollowUpService.DEFAULT_GAP_DAYS);
        assertEquals(4, FollowUpService.TOUCHES, "four touches, then archived");
    }

    @Test
    void aNewlyConnectedContactIsDueImmediately() {
        assertTrue(svc.isDue(contact(0, null, null), Instant.now()));
    }

    @Test
    void eachStageWaitsItsOwnGap() {
        Instant now = Instant.now();
        // stage 0 → 1 day, stage 1 → 2, stage 2 → 5, stage 3 → 10
        int[] gaps = { 1, 2, 5, 10 };
        for (int stage = 0; stage < gaps.length; stage++) {
            assertFalse(svc.isDue(contact(stage, daysAgo(gaps[stage] - 0.1), null), now),
                    "stage " + stage + " must still be waiting just before its gap");
            assertTrue(svc.isDue(contact(stage, daysAgo(gaps[stage] + 0.1), null), now),
                    "stage " + stage + " must be due just after its gap");
        }
    }

    @Test
    void theClockRunsFromTheLastTouchNotFromTheInvite() {
        // Otherwise a contact reached late gets three messages in one afternoon "catching up".
        PortalContact justTouched = contact(2, daysAgo(0.2), null);
        assertFalse(svc.isDue(justTouched, Instant.now()),
                "a contact messaged 5 hours ago must not be due again today");
    }

    @Test
    void theSequenceStopsAfterTheFourthTouch() {
        assertFalse(svc.isDue(contact(4, daysAgo(365), null), Instant.now()),
                "four touches is the whole sequence — never a fifth");
    }

    @Test
    void anArchivedContactIsNeverTouchedAgain() {
        assertFalse(svc.isDue(contact(1, daysAgo(365), Instant.now()), Instant.now()));
    }

    @Test
    void recordingATouchAdvancesTheStageAndRestartsTheClock() {
        PortalContact c = contact(0, daysAgo(3), null);
        when(contacts.findById(c.getId())).thenReturn(Optional.of(c));
        Instant now = Instant.now();
        PortalContact after = svc.recordTouch(USER, c.getId(), now);
        assertEquals(1, after.getFollowUpStage());
        assertEquals(now, after.getLastContactAt());
        assertNull(after.getArchivedAt(), "not finished yet");
        assertFalse(svc.isDue(after, now), "the clock restarted — not due again immediately");
    }

    @Test
    void theFinalTouchArchivesTheContact() {
        PortalContact c = contact(3, daysAgo(20), null);
        when(contacts.findById(c.getId())).thenReturn(Optional.of(c));
        PortalContact after = svc.recordTouch(USER, c.getId(), Instant.now());
        assertEquals(4, after.getFollowUpStage());
        assertNotNull(after.getArchivedAt(), "the sequence is spent — archive so it can't repeat");
    }

    @Test
    void anotherUsersContactCannotBeAdvanced() {
        PortalContact c = contact(0, null, null);
        c.setUserId(UUID.randomUUID());
        when(contacts.findById(c.getId())).thenReturn(Optional.of(c));
        assertNull(svc.recordTouch(USER, c.getId(), Instant.now()));
        verify(contacts, never()).save(any());
    }

    @Test
    void everyStageHasItsOwnAngleSoMessagesDoNotRepeat() {
        String s0 = svc.angleFor(0), s1 = svc.angleFor(1), s2 = svc.angleFor(2), s3 = svc.angleFor(3);
        assertNotEquals(s0, s1);
        assertNotEquals(s1, s2);
        assertNotEquals(s2, s3);
        assertFalse(s0.isBlank());
        // Out-of-range must not throw — it degrades to the last angle.
        assertDoesNotThrow(() -> svc.angleFor(99));
        assertDoesNotThrow(() -> svc.angleFor(-1));
    }

    @Test
    void dueListIsOldestFirstSoNobodyIsStarved() {
        PortalContact old = contact(0, daysAgo(30), null);
        PortalContact mid = contact(0, daysAgo(10), null);
        PortalContact recent = contact(0, daysAgo(2), null);
        when(contacts.findByUserIdAndConnectionStatusOrderByUpdatedAtDesc(eq(USER), eq("connected"), any()))
                .thenReturn(List.of(recent, old, mid));
        List<PortalContact> due = svc.due(USER, Instant.now(), 10);
        assertEquals(List.of(old, mid, recent), due);
    }

    @Test
    void dueListExcludesTheNotYetDueAndTheArchived() {
        PortalContact ready = contact(0, daysAgo(3), null);
        PortalContact waiting = contact(1, daysAgo(0.5), null);
        PortalContact archived = contact(2, daysAgo(50), Instant.now());
        when(contacts.findByUserIdAndConnectionStatusOrderByUpdatedAtDesc(eq(USER), eq("connected"), any()))
                .thenReturn(List.of(ready, waiting, archived));
        assertEquals(List.of(ready), svc.due(USER, Instant.now(), 10));
    }

    @Test
    void dueListRespectsTheLimit() {
        PortalContact a = contact(0, daysAgo(9), null);
        PortalContact b = contact(0, daysAgo(8), null);
        PortalContact c = contact(0, daysAgo(7), null);
        when(contacts.findByUserIdAndConnectionStatusOrderByUpdatedAtDesc(eq(USER), eq("connected"), any()))
                .thenReturn(List.of(a, b, c));
        assertEquals(2, svc.due(USER, Instant.now(), 2).size());
    }

    @Test
    void nextDueAtIsNullOnceTheSequenceIsOver() {
        assertNull(svc.nextDueAt(contact(4, daysAgo(1), null)));
        assertNull(svc.nextDueAt(contact(1, daysAgo(1), Instant.now())));
        assertNotNull(svc.nextDueAt(contact(1, daysAgo(1), null)));
    }

    @Test
    void nullsDoNotThrow() {
        assertFalse(svc.isDue(null, Instant.now()));
        assertNull(svc.nextDueAt(null));
    }
}
