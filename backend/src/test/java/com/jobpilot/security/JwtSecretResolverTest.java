package com.jobpilot.security;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Production must not be able to sign a session with anything weak or public, and a laptop
 * must still run with no configuration at all. Both halves matter: a guard that breaks local
 * development gets deleted rather than satisfied.
 */
class JwtSecretResolverTest {

    private static final String REMOTE =
            "jdbc:postgresql://aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres";
    private static final String LOCAL = "jdbc:postgresql://localhost:5432/jobpilot";
    private static final String PUBLISHED = "change-me-jobpilot-dev-jwt-secret";
    private static final String STRONG = "Zk8rT2pLqW4vXnB7yH3sMd9cF1aQeR6uJiO0lPzA5tGv";

    @Test
    void productionRefusesTheSecretThatWasPublishedInThisRepository() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> JwtSecretResolver.resolveKey(PUBLISHED, REMOTE));
        assertTrue(e.getMessage().contains("published"), e.getMessage());
    }

    @Test
    void productionRefusesAnAbsentSecret() {
        assertThrows(IllegalStateException.class, () -> JwtSecretResolver.resolveKey("", REMOTE));
        assertThrows(IllegalStateException.class, () -> JwtSecretResolver.resolveKey(null, REMOTE));
        assertThrows(IllegalStateException.class, () -> JwtSecretResolver.resolveKey("   ", REMOTE));
    }

    @Test
    void productionRefusesAShortSecret() {
        // 31 characters — one under the bar, to prove the bar is where it claims to be.
        String justTooShort = "a".repeat(JwtSecretResolver.MIN_PRODUCTION_LENGTH - 1);
        assertThrows(IllegalStateException.class,
                () -> JwtSecretResolver.resolveKey(justTooShort, REMOTE));
        // Exactly at the bar is acceptable.
        assertDoesNotThrow(() -> JwtSecretResolver.resolveKey(
                "a".repeat(JwtSecretResolver.MIN_PRODUCTION_LENGTH), REMOTE));
    }

    @Test
    void productionAcceptsAStrongSecret() {
        byte[] key = JwtSecretResolver.resolveKey(STRONG, REMOTE);
        assertEquals(32, key.length, "HS256 needs exactly 32 bytes of key material");
    }

    @Test
    void localDevelopmentRunsWithNoConfigurationAtAll() {
        // The whole reason a published default existed. It has to keep working, or the next
        // person reinstates the default rather than configuring a laptop.
        byte[] key = assertDoesNotThrow(() -> JwtSecretResolver.resolveKey("", LOCAL));
        assertEquals(32, key.length);
    }

    @Test
    void anEphemeralLocalKeyIsDifferentEveryProcess() {
        // Sessions not surviving a restart is the price, and it is strictly safer than every
        // developer sharing one known key.
        assertFalse(java.util.Arrays.equals(
                JwtSecretResolver.resolveKey("", LOCAL),
                JwtSecretResolver.resolveKey("", LOCAL)));
    }

    @Test
    void theKeyIsDerivedWithoutAPublicPaddingConstant() {
        // The old code appended a fixed public string to reach 32 bytes, which made a short
        // secret look like a long key. SHA-256 means entropy in equals entropy out.
        byte[] a = JwtSecretResolver.resolveKey(STRONG, REMOTE);
        byte[] b = JwtSecretResolver.resolveKey(STRONG + "x", REMOTE);
        assertFalse(java.util.Arrays.equals(a, b), "different secrets must give different keys");
        assertArrayEquals(a, JwtSecretResolver.resolveKey(STRONG, REMOTE), "must be deterministic");
    }

    @Test
    void aRemoteDatabaseIsProductionAndALocalOneIsNot() {
        assertTrue(JwtSecretResolver.isProduction(REMOTE));
        assertFalse(JwtSecretResolver.isProduction(LOCAL));
        assertFalse(JwtSecretResolver.isProduction("jdbc:h2:mem:test"));
        assertFalse(JwtSecretResolver.isProduction(""));
        assertFalse(JwtSecretResolver.isProduction("jdbc:postgresql://127.0.0.1:5432/x"));
    }
}
