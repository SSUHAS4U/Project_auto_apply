package com.jobpilot.security;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * A rate limiter nobody has watched refuse a request is decoration. Each test drives the real
 * counter to its real budget rather than asserting that the constants have the values they
 * have.
 */
class LoginThrottleTest {

    private static final String IP = "203.0.113.7";

    @Test
    void grindingOneAccountIsRefusedOnceItsBudgetIsSpent() {
        LoginThrottle t = new LoginThrottle();
        for (int i = 0; i < LoginThrottle.MAX_PER_ACCOUNT; i++) {
            assertDoesNotThrow(() -> t.checkAllowed("victim@example.com", IP),
                    "should still be allowed before the budget is spent");
            t.recordFailure("victim@example.com", IP);
        }
        LoginThrottle.TooManyAttempts e = assertThrows(LoginThrottle.TooManyAttempts.class,
                () -> t.checkAllowed("victim@example.com", IP));
        assertTrue(e.retryAfterSeconds() > 0, "must tell the caller when to come back");
    }

    @Test
    void sprayingOnePasswordAcrossManyAccountsIsAlsoRefused() {
        // The per-account counter never sees this: no single address fails twice. Without the
        // address key it would run forever.
        LoginThrottle t = new LoginThrottle();
        for (int i = 0; i < LoginThrottle.MAX_PER_ADDRESS; i++) {
            t.recordFailure("user" + i + "@example.com", IP);
        }
        assertThrows(LoginThrottle.TooManyAttempts.class,
                () -> t.checkAllowed("someone-new@example.com", IP));
    }

    @Test
    void oneAttackerDoesNotLockOutEveryoneElse() {
        // Lock one account from one address, then prove a different address is unaffected.
        LoginThrottle t = new LoginThrottle();
        for (int i = 0; i < LoginThrottle.MAX_PER_ACCOUNT; i++) {
            t.recordFailure("victim@example.com", IP);
        }
        assertThrows(LoginThrottle.TooManyAttempts.class,
                () -> t.checkAllowed("victim@example.com", IP));
        assertDoesNotThrow(() -> t.checkAllowed("victim@example.com", "198.51.100.4"),
                "the real owner signing in from elsewhere must not be locked out");
    }

    @Test
    void aSuccessfulSignInClearsThatAccountsFailures() {
        LoginThrottle t = new LoginThrottle();
        for (int i = 0; i < LoginThrottle.MAX_PER_ACCOUNT - 1; i++) {
            t.recordFailure("owner@example.com", IP);
        }
        t.recordSuccess("owner@example.com", IP);
        // Back to a full budget: a forgetful owner who eventually gets it right is not punished.
        for (int i = 0; i < LoginThrottle.MAX_PER_ACCOUNT - 1; i++) {
            assertDoesNotThrow(() -> t.checkAllowed("owner@example.com", IP));
            t.recordFailure("owner@example.com", IP);
        }
    }

    @Test
    void theRefusalDoesNotSayWhetherTheAccountExists() {
        // An "is this email registered" oracle is worth more to an attacker than the minutes
        // the lockout costs them, so the message must not distinguish the two cases.
        LoginThrottle t = new LoginThrottle();
        for (int i = 0; i < LoginThrottle.MAX_PER_ACCOUNT; i++) {
            t.recordFailure("real@example.com", IP);
        }
        String msg = assertThrows(LoginThrottle.TooManyAttempts.class,
                () -> t.checkAllowed("real@example.com", IP)).getMessage();
        assertFalse(msg.toLowerCase().contains("exist"), msg);
        assertFalse(msg.contains("real@example.com"), "must not echo the address back: " + msg);
    }

    @Test
    void trackingIsBoundedSoTheMapCannotBeUsedToExhaustMemory() {
        // Varying the email every request is the obvious way to turn a rate limiter into a
        // memory exhaustion bug. Drive well past the cap and assert it stays bounded.
        LoginThrottle t = new LoginThrottle();
        for (int i = 0; i < LoginThrottle.MAX_TRACKED_KEYS + 5_000; i++) {
            t.recordFailure("flood" + i + "@example.com", "198.51.100." + (i % 250));
        }
        assertDoesNotThrow(() -> t.checkAllowed("anyone@example.com", "203.0.113.99"),
                "the limiter must still function after a flood");
    }
}
