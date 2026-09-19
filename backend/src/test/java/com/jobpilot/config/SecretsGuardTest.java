package com.jobpilot.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The guard must fire on exactly the case that matters and stay out of the way otherwise.
 *
 * A guard that has never been seen to fail is decoration, and one that fires locally would be
 * ripped out within a week — so both halves are asserted.
 */
class SecretsGuardTest {

    private static final String PUBLISHED_JWT = "change-me-jobpilot-dev-jwt-secret";
    private static final String REMOTE_DB =
            "jdbc:postgresql://aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres";
    private static final String LOCAL_DB = "jdbc:postgresql://localhost:5432/jobpilot";

    private JobPilotProperties props(String jwt, String apiToken) {
        JobPilotProperties p = new JobPilotProperties();
        p.getJwt().setSecret(jwt);
        p.setApiToken(apiToken);
        return p;
    }

    @Test
    void theJwtSecretIsNotThisClassesJob() {
        // JwtSecretResolver refuses to produce a signing key at all, which happens earlier
        // than this check and is stronger. Two owners for one secret would drift.
        SecretsGuard g = new SecretsGuard(props(PUBLISHED_JWT, "a-real-token"), REMOTE_DB, true);
        assertDoesNotThrow(g::check);
        assertTrue(g.findings().isEmpty(), "should report only on the machine token");
    }

    @Test
    void refusesOnThePublishedMachineTokenToo() {
        SecretsGuard g = new SecretsGuard(props("a-real-secret", "dev-token"), REMOTE_DB, true);
        assertThrows(IllegalStateException.class, g::check);
    }

    @Test
    void localDevelopmentIsUntouched() {
        // The whole point of the defaults is that a fresh clone runs. If this guard broke that,
        // the next person would delete it rather than configure around it.
        SecretsGuard g = new SecretsGuard(props(PUBLISHED_JWT, "dev-token"), LOCAL_DB, true);
        assertDoesNotThrow(g::check);
    }

    @Test
    void anEmbeddedOrAbsentDatasourceIsNotProduction() {
        assertDoesNotThrow(() -> new SecretsGuard(props(PUBLISHED_JWT, "dev-token"), "", true).check());
        assertDoesNotThrow(() -> new SecretsGuard(props(PUBLISHED_JWT, "dev-token"),
                "jdbc:h2:mem:test", true).check());
    }

    @Test
    void reportsWithoutKillingTheProcessWhenEnforcementIsOff() {
        // The staged-rollout mode: the finding must be RECORDED and readable even though the
        // process is allowed to start, otherwise the first deploy tells us nothing.
        SecretsGuard g = new SecretsGuard(props(PUBLISHED_JWT, "dev-token"), REMOTE_DB, false);
        assertDoesNotThrow(g::check);
        assertEquals(java.util.List.of("JOBPILOT_API_TOKEN"), g.findings());
        assertFalse(g.isEnforcing());
    }

    @Test
    void findingsNeverContainTheSecretValues() {
        SecretsGuard g = new SecretsGuard(props(PUBLISHED_JWT, "dev-token"), REMOTE_DB, false);
        g.check();
        for (String f : g.findings()) {
            assertFalse(f.contains("dev-token"), "a finding leaked the token value: " + f);
        }
    }

    @Test
    void realSecretsOnARemoteDatabaseStartNormally() {
        SecretsGuard g = new SecretsGuard(
                props("HkS2+9xq3mBv1TnPqRfL0aZcYw8UeJdO", "b7f3a91c55de0428"), REMOTE_DB, true);
        assertDoesNotThrow(g::check);
    }
}
