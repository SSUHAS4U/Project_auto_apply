package com.jobpilot.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Locale;

/**
 * Decides what actually signs a session, and refuses to let production sign with anything
 * weak or public.
 *
 * <h2>What went wrong</h2>
 *
 * {@code application.yml} used to carry {@code JOBPILOT_JWT_SECRET:change-me-jobpilot-dev-jwt-secret}
 * so a fresh clone would run without configuration. This repository is public, and the GCP
 * deployment never set the variable — so production signed every session with a string anyone
 * could read on GitHub, padded to key length by a constant that was in the same file. Confirmed
 * live on 2026-09-19 via {@code /api/ingest-diag/config}.
 *
 * The convenience and the vulnerability were the same line. This class keeps the convenience
 * and removes the vulnerability:
 *
 * <ul>
 *   <li><b>No default is published.</b> The config default is empty; there is no literal in
 *       this repository that has ever signed anything.</li>
 *   <li><b>Development still works with zero configuration</b> — an unset secret produces a
 *       random one for that process. Sessions do not survive a restart, which is a fair price
 *       for a laptop and is strictly safer than a shared known key.</li>
 *   <li><b>Production fails closed.</b> Absent, too short, or a known-published value and the
 *       application refuses to start. A backend that will not boot is a visible problem; a
 *       backend anyone can forge a session for is not.</li>
 * </ul>
 *
 * <h2>Key derivation</h2>
 *
 * The old code appended a fixed public string to reach HS256's 256-bit minimum. That is
 * harmless for a strong secret and actively misleading for a weak one, since it makes a short
 * secret look like a long key. The key is now SHA-256 of the secret: always exactly 32 bytes,
 * no public constant involved, and entropy in equals entropy out.
 *
 * Changing the derivation invalidates existing tokens. That is intended — every session issued
 * before this change was signed with the published key and should not survive it.
 */
public final class JwtSecretResolver {

    private static final Logger log = LoggerFactory.getLogger(JwtSecretResolver.class);

    /** Values that have appeared in this repository. None of them is a secret any more. */
    private static final java.util.Set<String> PUBLISHED = java.util.Set.of(
            "change-me-jobpilot-dev-jwt-secret",
            "change-me",
            "secret");

    /** Below this, a secret is guessable enough that it should never reach production. */
    static final int MIN_PRODUCTION_LENGTH = 32;

    private JwtSecretResolver() {
    }

    /** True when the datasource points somewhere other than this machine. */
    static boolean isProduction(String datasourceUrl) {
        String u = datasourceUrl == null ? "" : datasourceUrl.toLowerCase(Locale.ROOT);
        if (u.isBlank()) return false;
        return !(u.contains("localhost") || u.contains("127.0.0.1") || u.contains(":h2:")
                || u.contains("hsqldb") || u.contains("testcontainers"));
    }

    /**
     * The 32-byte HMAC key for this process.
     *
     * @throws IllegalStateException in production when the secret is missing, too short, or a
     *                               value published in this repository.
     */
    public static byte[] resolveKey(String configured, String datasourceUrl) {
        String secret = configured == null ? "" : configured.trim();
        boolean production = isProduction(datasourceUrl);

        if (secret.isEmpty()) {
            if (production) {
                throw new IllegalStateException(problem(
                        "JOBPILOT_JWT_SECRET is not set",
                        "Sessions cannot be signed safely without it."));
            }
            String ephemeral = randomSecret();
            log.warn("JOBPILOT_JWT_SECRET is not set — generated a RANDOM one for this process. "
                    + "Sessions will not survive a restart. This is local-development behaviour; "
                    + "against a remote database the application would refuse to start.");
            return sha256(ephemeral);
        }

        if (PUBLISHED.contains(secret)) {
            if (production) {
                throw new IllegalStateException(problem(
                        "JOBPILOT_JWT_SECRET is a value published in this repository",
                        "Anyone who can read the repository can forge a session for any user."));
            }
            log.warn("JOBPILOT_JWT_SECRET is a published value. Tolerated locally; production "
                    + "would refuse to start.");
        } else if (secret.length() < MIN_PRODUCTION_LENGTH) {
            if (production) {
                throw new IllegalStateException(problem(
                        "JOBPILOT_JWT_SECRET is only " + secret.length() + " characters",
                        "At least " + MIN_PRODUCTION_LENGTH + " are required in production."));
            }
            log.warn("JOBPILOT_JWT_SECRET is shorter than {} characters. Tolerated locally.",
                    MIN_PRODUCTION_LENGTH);
        }

        return sha256(secret);
    }

    private static String problem(String what, String why) {
        return "\n\n*** REFUSING TO START ***\n\n  " + what + "\n  " + why
                + "\n\nSet one on the host (this deployment: ~/jobpilot/.env):\n"
                + "  JOBPILOT_JWT_SECRET=$(openssl rand -base64 48)\n\n"
                + "Then restart. Everyone signs in again, which is the point if the previous\n"
                + "key was weak or public.\n";
    }

    private static String randomSecret() {
        byte[] b = new byte[48];
        new SecureRandom().nextBytes(b);
        return Base64.getEncoder().encodeToString(b);
    }

    /** Always 32 bytes, with no public padding constant in the mix. */
    private static byte[] sha256(String s) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
