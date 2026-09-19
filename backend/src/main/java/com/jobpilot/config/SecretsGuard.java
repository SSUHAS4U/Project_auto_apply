package com.jobpilot.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * Refuse to run in production with a secret that is published in this repository.
 *
 * <h2>The exposure</h2>
 *
 * This repository is PUBLIC. {@code application.yml} carries development defaults so a fresh
 * clone starts without configuration — which is the right call for a dev default and a
 * catastrophic one if it reaches production:
 *
 * <pre>
 *   jwt.secret  -> "change-me-jobpilot-dev-jwt-secret"
 *   api-token   -> "dev-token"
 * </pre>
 *
 * {@code JwtService} signs HS256 with that value, padded by a constant that is also in this
 * repository. So a backend running on the default signs sessions with a key any reader can
 * reconstruct — and a forged token needs only a user id to become that user, across all 88
 * user-authenticated endpoints. That includes the automation, which applies to jobs and sends
 * email on the owner's behalf.
 *
 * The static {@code api-token} is the same story for the machine surface: ingest, the daily
 * pipeline, the digest and the source list.
 *
 * <h2>Why this fails closed rather than warning</h2>
 *
 * A warning in a log nobody reads is how this state persists. {@code CLAUDE.md} requires
 * failing closed for anything that "sends, spends, deletes, or applies on the user's behalf",
 * and a forgeable session is exactly that. A backend that will not start is a visible, fixable
 * problem; a backend anyone can authenticate to is neither.
 *
 * <h2>How to satisfy it</h2>
 *
 * Set real values on the host — for this deployment, {@code ~/jobpilot/.env}:
 *
 * <pre>
 *   JOBPILOT_JWT_SECRET=$(openssl rand -base64 48)
 *   JOBPILOT_API_TOKEN=$(openssl rand -hex 24)
 * </pre>
 *
 * Changing {@code JOBPILOT_JWT_SECRET} invalidates every existing session, so everyone signs in
 * again. That is the correct cost of rotating a signing key, and if the old one was the
 * published default then invalidating those sessions is the entire point.
 *
 * Local development is unaffected: the check only applies when a datasource points somewhere
 * other than localhost, which is what distinguishes "someone ran this on their laptop" from
 * "this is serving the internet".
 */
@Component
public class SecretsGuard {

    private static final Logger log = LoggerFactory.getLogger(SecretsGuard.class);

    /**
     * The published machine-token default. Public knowledge, not a secret.
     *
     * The JWT secret is NOT checked here any more — JwtSecretResolver owns that policy and
     * refuses to produce a signing key at all, which is strictly earlier and stronger than a
     * post-startup check. One owner per secret; two would drift.
     */
    private static final String DEFAULT_API_TOKEN = "dev-token";

    private final JobPilotProperties props;
    private final String datasourceUrl;
    /**
     * Whether a published default is fatal or merely reported.
     *
     * Defaulted to FALSE for exactly one deploy, to find out what production was actually
     * running on without risking an outage to ask. The answer came back — the machine token
     * was already strong, only the JWT secret was the published one — so this is TRUE now.
     * Set it false only to diagnose, never to live with.
     */
    private final boolean enforce;

    public SecretsGuard(JobPilotProperties props,
                        @org.springframework.beans.factory.annotation.Value(
                                "${spring.datasource.url:}") String datasourceUrl,
                        @org.springframework.beans.factory.annotation.Value(
                                "${jobpilot.security.enforce-secrets:true}") boolean enforce) {
        this.props = props;
        this.datasourceUrl = datasourceUrl == null ? "" : datasourceUrl;
        this.enforce = enforce;
    }

    /**
     * "Production" means the database is not on this machine.
     *
     * Deliberately not keyed on a Spring profile: profiles are set by whoever deploys, and the
     * failure this guards against is precisely someone deploying without setting things. The
     * datasource is not optional and cannot be forgotten, so it is the honest signal.
     */
    private boolean looksLikeProduction() {
        String u = datasourceUrl.toLowerCase(java.util.Locale.ROOT);
        if (u.isBlank()) return false;
        return !(u.contains("localhost") || u.contains("127.0.0.1") || u.contains(":h2:")
                || u.contains("hsqldb") || u.contains("testcontainers"));
    }

    /**
     * Which published defaults this process is running on, as names only.
     *
     * NEVER the values. The names are already public — they are in this file — so reporting
     * them leaks nothing; reporting the secret itself would be the very thing being guarded
     * against. Read through the machine-token diagnostics endpoint.
     */
    private volatile List<String> findings = List.of();

    public List<String> findings() {
        return findings;
    }

    /** Whether a published default would stop this process starting. */
    public boolean isEnforcing() {
        return enforce;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void check() {
        List<String> published = new ArrayList<>();
        if (DEFAULT_API_TOKEN.equals(props.getApiToken())) {
            published.add("JOBPILOT_API_TOKEN — the machine surface (ingest, daily, digest, "
                    + "sources) accepts a token published in this repository");
        }
        // Record BEFORE deciding what to do about it, so the diagnostics endpoint can answer
        // "is this deployment on a published key?" whether or not the guard is enforcing yet.
        this.findings = List.copyOf(published.stream().map(s -> s.split(" — ")[0]).toList());

        if (published.isEmpty()) return;

        if (!looksLikeProduction()) {
            log.warn("Running with {} development secret(s). Fine locally; this would refuse to "
                    + "start against a remote database.", published.size());
            return;
        }

        StringBuilder msg = new StringBuilder(
                "\n\n*** REFUSING TO SERVE: this deployment is using secrets published in a "
                        + "public repository ***\n\n");
        for (String p : published) msg.append("  - ").append(p).append('\n');
        msg.append("\nSet real values on the host (this deployment: ~/jobpilot/.env):\n")
           .append("  JOBPILOT_JWT_SECRET=$(openssl rand -base64 48)\n")
           .append("  JOBPILOT_API_TOKEN=$(openssl rand -hex 24)\n")
           .append("\nThen restart. Rotating the JWT secret signs everyone out, which is the\n")
           .append("point if the old one was the published default.\n");
        log.error(msg.toString());

        if (enforce) {
            throw new IllegalStateException(
                    "Refusing to start with published default secret(s): " + published.size()
                            + " — see the log above.");
        }
        log.error("NOT refusing to start, because jobpilot.security.enforce-secrets is false. "
                + "This is a staged rollout: the finding is readable at /api/ingest-diag/config "
                + "with the machine token, and enforcement turns on once the host is confirmed "
                + "configured. Leaving it off permanently defeats the purpose.");
    }
}
