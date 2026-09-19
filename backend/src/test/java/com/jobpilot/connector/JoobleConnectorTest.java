package com.jobpilot.connector;

import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Jooble's response shape, pinned against what the live API actually returned.
 *
 * The connector exists because Scout looked one up by name for years and no class provided it,
 * so the channel was silently absent. A parse test is the cheap way to notice if the payload
 * changes shape again — without it, a renamed field degrades to "0 found", which looks exactly
 * like a quiet day on the job market.
 */
class JoobleConnectorTest {

    /** Verified live on 2026-09-19: ISO local date-time, no zone, SEVEN fractional digits. */
    @Test
    void parsesJoobleSevenDigitFractionalTimestamp() {
        Instant t = JoobleConnector.parseUpdated("2026-09-04T00:00:00.0000000");
        assertNotNull(t, "a 7-digit fraction must parse — java.time accepts at most 9");
        assertEquals(Instant.parse("2026-09-04T00:00:00Z"), t);
    }

    @Test
    void parsesAPlainTimestampWithoutAFraction() {
        assertEquals(Instant.parse("2026-09-07T13:45:00Z"),
                JoobleConnector.parseUpdated("2026-09-07T13:45:00"));
    }

    @Test
    void anUnparseableTimestampYieldsNullRatherThanThrowing() {
        // A bad date must cost us that listing's posted-at, never the whole batch.
        assertNull(JoobleConnector.parseUpdated("not-a-date"));
        assertNull(JoobleConnector.parseUpdated(""));
        assertNull(JoobleConnector.parseUpdated(null));
    }
}
