package com.jobpilot.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Makes guessing a password expensive.
 *
 * <h2>What was missing</h2>
 *
 * {@code /api/auth/login} is public and had no attempt counter, no delay and no lockout. The
 * only brake was BCrypt's own cost, and registration accepts a six-character password — so an
 * unauthenticated attacker could grind a known email address, or spray one common password
 * across many addresses, for as long as they liked, and nothing recorded that it was happening.
 *
 * <h2>Two keys, because there are two attacks</h2>
 *
 * <ul>
 *   <li><b>email + client address</b> — one attacker grinding one account.</li>
 *   <li><b>client address alone</b> — one attacker spraying one password across many accounts,
 *       which the per-email counter never sees because no single email fails twice.</li>
 * </ul>
 *
 * Either key tripping is enough to refuse. The address-only budget is deliberately larger, so
 * a household or office behind one NAT address is not locked out by one forgetful person.
 *
 * <h2>Deliberate limits</h2>
 *
 * In-memory and per-instance. This deployment is a single backend container, so that is the
 * whole population; behind several instances an attacker would get one budget per instance and
 * this would need shared state. Stated here rather than discovered later.
 *
 * A locked key reports the same failure the caller would otherwise see plus a retry time. It
 * does NOT reveal whether the address exists — the message is identical for a real and an
 * unknown account, because an oracle for "is this email registered" is worth more to an
 * attacker than the few seconds the lockout costs them.
 */
@Component
public class LoginThrottle {

    private static final Logger log = LoggerFactory.getLogger(LoginThrottle.class);

    /** Failures allowed for one email from one address before that pair is refused. */
    static final int MAX_PER_ACCOUNT = 8;
    /** Failures allowed from one address across ALL accounts — catches password spraying. */
    static final int MAX_PER_ADDRESS = 25;
    /** How long a tripped key stays refused. */
    static final Duration LOCKOUT = Duration.ofMinutes(15);
    /** Failures older than this stop counting, so an honest typo does not accumulate forever. */
    static final Duration WINDOW = Duration.ofMinutes(15);
    /**
     * Hard cap on tracked keys.
     *
     * Without it the map IS the vulnerability: an attacker varying the email on every request
     * would grow it without bound until the process died. At the cap the oldest entries are
     * dropped, which loses some counting under flood but never memory.
     */
    static final int MAX_TRACKED_KEYS = 20_000;

    private static final class Counter {
        final AtomicInteger failures = new AtomicInteger();
        volatile Instant firstFailure = Instant.now();
        volatile Instant lockedUntil = Instant.EPOCH;
    }

    private final Map<String, Counter> counters = new ConcurrentHashMap<>();

    /** Thrown when a key is refused. Carries how long the caller must wait. */
    public static class TooManyAttempts extends RuntimeException {
        private final long retryAfterSeconds;

        TooManyAttempts(long retryAfterSeconds) {
            super("too many sign-in attempts — try again in "
                    + Math.max(1, retryAfterSeconds / 60) + " minute(s)");
            this.retryAfterSeconds = retryAfterSeconds;
        }

        public long retryAfterSeconds() {
            return retryAfterSeconds;
        }
    }

    /** @throws TooManyAttempts when either the account key or the address key is locked. */
    public void checkAllowed(String email, String clientAddress) {
        Instant now = Instant.now();
        for (String key : keys(email, clientAddress)) {
            Counter c = counters.get(key);
            if (c != null && c.lockedUntil.isAfter(now)) {
                throw new TooManyAttempts(Duration.between(now, c.lockedUntil).getSeconds());
            }
        }
    }

    /** Count a failed sign-in against both keys, locking whichever trips its budget. */
    public void recordFailure(String email, String clientAddress) {
        Instant now = Instant.now();
        evictIfOversized();
        String[] ks = keys(email, clientAddress);
        int[] budgets = { MAX_PER_ACCOUNT, MAX_PER_ADDRESS };
        for (int i = 0; i < ks.length; i++) {
            Counter c = counters.computeIfAbsent(ks[i], k -> new Counter());
            // A quiet spell resets the count; otherwise one typo a week would eventually lock.
            if (Duration.between(c.firstFailure, now).compareTo(WINDOW) > 0) {
                c.failures.set(0);
                c.firstFailure = now;
            }
            if (c.failures.incrementAndGet() >= budgets[i]) {
                c.lockedUntil = now.plus(LOCKOUT);
                c.failures.set(0);
                c.firstFailure = now;
                log.warn("Sign-in locked for {} minutes after {} failures ({})",
                        LOCKOUT.toMinutes(), budgets[i], i == 0 ? "account+address" : "address");
            }
        }
    }

    /** A success clears the account key. The address key stands: spraying succeeds sometimes. */
    public void recordSuccess(String email, String clientAddress) {
        counters.remove(keys(email, clientAddress)[0]);
    }

    private static String[] keys(String email, String clientAddress) {
        String e = email == null ? "" : email.trim().toLowerCase(java.util.Locale.ROOT);
        String a = clientAddress == null || clientAddress.isBlank() ? "unknown" : clientAddress;
        return new String[] { "acct:" + e + "|" + a, "addr:" + a };
    }

    /** Drop expired entries, and if still over the cap, drop everything and start again. */
    private void evictIfOversized() {
        if (counters.size() < MAX_TRACKED_KEYS) return;
        Instant now = Instant.now();
        counters.entrySet().removeIf(en -> {
            Counter c = en.getValue();
            return c.lockedUntil.isBefore(now)
                    && Duration.between(c.firstFailure, now).compareTo(WINDOW) > 0;
        });
        if (counters.size() >= MAX_TRACKED_KEYS) {
            // Losing counts is the lesser evil; an unbounded map is a way to kill the process.
            log.warn("Login throttle tracking {} keys — clearing. This looks like a flood.",
                    counters.size());
            counters.clear();
        }
    }
}
