package com.jobpilot.security;

import com.jobpilot.config.JobPilotProperties;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;

/**
 * AES-256-GCM encryption for document bytes at rest. The column never stores plaintext,
 * so a DB dump alone can't reveal documents — the master key lives only in an env var.
 * Output layout: [12-byte IV][ciphertext+tag].
 */
@Component
public class DocumentCrypto {

    private static final int IV_LEN = 12;
    private static final int TAG_BITS = 128;
    private final SecretKeySpec key;
    private final SecureRandom random = new SecureRandom();

    /**
     * The key never changes silently, because a changed key is destroyed data.
     *
     * This falls back to the JWT secret when no dedicated key is set — which made rotating the
     * JWT secret a silent data-loss event: every document already on disk was encrypted under
     * the old derivation and nothing would decrypt them again. AES-GCM fails authentication
     * rather than returning garbage, so the loss would surface as "download broken", not as a
     * crypto error anyone would connect to a secret rotation.
     *
     * Production therefore requires JOBPILOT_DOC_KEY to be set EXPLICITLY. On an existing
     * deployment it must be set to whatever key the stored documents were encrypted under
     * before the JWT secret is rotated — see the bootstrap step in deploy-backend.yml, which
     * does exactly that, in that order.
     */
    public DocumentCrypto(JobPilotProperties props,
                          @org.springframework.beans.factory.annotation.Value(
                                  "${spring.datasource.url:}") String datasourceUrl) {
        boolean haveDocKey = props.getDocKey() != null && !props.getDocKey().isBlank();
        if (!haveDocKey && com.jobpilot.security.JwtSecretResolver.isProduction(datasourceUrl)) {
            throw new IllegalStateException("""

                    *** REFUSING TO START ***

                      JOBPILOT_DOC_KEY is not set, so document encryption falls back to the
                      JWT secret. Rotating that secret then destroys every stored document,
                      irreversibly — AES-GCM fails authentication rather than returning
                      garbage, so it surfaces as "download broken", not as a crypto error
                      anyone would connect to a secret rotation.

                      On an EXISTING deployment set it to the key the documents were already
                      encrypted under, NEVER a fresh random value.
                    """);
        }
        String secret = haveDocKey ? props.getDocKey() : props.getJwt().getSecret();
        try {
            byte[] k = MessageDigest.getInstance("SHA-256")
                    .digest(("jobpilot-doc::" + secret).getBytes(StandardCharsets.UTF_8));
            this.key = new SecretKeySpec(k, "AES");
        } catch (Exception e) {
            throw new IllegalStateException("failed to init document crypto", e);
        }
    }

    public byte[] encrypt(byte[] plain) {
        try {
            byte[] iv = new byte[IV_LEN];
            random.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            byte[] ct = c.doFinal(plain);
            byte[] out = new byte[IV_LEN + ct.length];
            System.arraycopy(iv, 0, out, 0, IV_LEN);
            System.arraycopy(ct, 0, out, IV_LEN, ct.length);
            return out;
        } catch (Exception e) {
            throw new IllegalStateException("encryption failed: " + e.getMessage(), e);
        }
    }

    public byte[] decrypt(byte[] stored) {
        try {
            byte[] iv = Arrays.copyOfRange(stored, 0, IV_LEN);
            byte[] ct = Arrays.copyOfRange(stored, IV_LEN, stored.length);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            return c.doFinal(ct);
        } catch (Exception e) {
            throw new IllegalStateException("decryption failed: " + e.getMessage(), e);
        }
    }
}
