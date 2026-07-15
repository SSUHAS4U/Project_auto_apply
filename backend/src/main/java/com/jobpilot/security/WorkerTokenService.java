package com.jobpilot.security;

import com.jobpilot.domain.AppSecret;
import com.jobpilot.repository.AppSecretRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

/**
 * Issues and verifies the long-lived token the LOCAL worker uses to authenticate to
 * {@code /api/worker/**}. The token is bound to the user who issued it: the stored
 * value is {@code userId|secret}, AES-GCM encrypted at rest (never plaintext in the DB).
 * The worker only ever holds the raw secret; verification returns the owning user id.
 */
@Service
public class WorkerTokenService {

    private static final String SECRET_NAME = "worker.token";

    private final AppSecretRepository repo;
    private final DocumentCrypto crypto;
    private final SecureRandom random = new SecureRandom();

    public WorkerTokenService(AppSecretRepository repo, DocumentCrypto crypto) {
        this.repo = repo;
        this.crypto = crypto;
    }

    /** True once a worker token has been issued. */
    public boolean isConfigured() {
        return repo.findById(SECRET_NAME).isPresent();
    }

    /** Generate a fresh token for this user, replacing any existing one. Returns the raw secret ONCE. */
    @Transactional
    public String issue(UUID userId) {
        byte[] buf = new byte[32];
        random.nextBytes(buf);
        String secret = Base64.getUrlEncoder().withoutPadding().encodeToString(buf);
        String stored = userId + "|" + secret;
        AppSecret s = repo.findById(SECRET_NAME).orElseGet(AppSecret::new);
        s.setName(SECRET_NAME);
        s.setValueEnc(Base64.getEncoder().encodeToString(
                crypto.encrypt(stored.getBytes(StandardCharsets.UTF_8))));
        s.setUpdatedAt(Instant.now());
        repo.save(s);
        return secret;
    }

    /** Verify a presented token; returns the owning user id, or null if invalid. */
    public UUID verify(String presented) {
        if (presented == null || presented.isBlank()) return null;
        AppSecret s = repo.findById(SECRET_NAME).orElse(null);
        if (s == null) return null;
        try {
            String stored = new String(
                    crypto.decrypt(Base64.getDecoder().decode(s.getValueEnc())), StandardCharsets.UTF_8);
            int bar = stored.indexOf('|');
            if (bar < 0) return null;
            String userId = stored.substring(0, bar);
            String secret = stored.substring(bar + 1);
            boolean ok = MessageDigest.isEqual(
                    secret.getBytes(StandardCharsets.UTF_8),
                    presented.trim().getBytes(StandardCharsets.UTF_8));
            return ok ? UUID.fromString(userId) : null;
        } catch (Exception e) {
            return null;
        }
    }
}
