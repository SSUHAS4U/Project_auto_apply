package com.jobpilot.security;

import com.jobpilot.config.JobPilotProperties;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.util.Arrays;

/**
 * AES-256-GCM encryption for document bytes at rest. The column never stores plaintext,
 * so a DB dump alone can't reveal documents — the master key lives only in an env var.
 * Output layout: [12-byte IV][ciphertext+tag].
 */
@Component
public class DocumentCrypto {

    private static final Logger log = LoggerFactory.getLogger(DocumentCrypto.class);

    private static final int IV_LEN = 12;
    private static final int TAG_BITS = 128;
    private final SecretKeySpec primary;
    private final SecretKeySpec previous;
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
        String primarySecret = haveDocKey ? props.getDocKey() : props.getJwt().getSecret();
        this.primary = aesKey(primarySecret);
        String prev = props.getDocKeyPrevious();
        this.previous = (prev == null || prev.isBlank()) ? null : aesKey(prev);
        if (this.previous != null) {
            log.info("Document crypto: primary key active, previous key retained for reading "
                    + "legacy blobs. Remove JOBPILOT_DOC_KEY_PREVIOUS once the re-key has run.");
        }
    }

    private static SecretKeySpec aesKey(String secret) {
        try {
            return new SecretKeySpec(MessageDigest.getInstance("SHA-256")
                    .digest(("jobpilot-doc::" + secret).getBytes(StandardCharsets.UTF_8)), "AES");
        } catch (Exception e) {
            throw new IllegalStateException("failed to init document crypto", e);
        }
    }

    /**
     * Marks a blob as written under the CURRENT key.
     *
     * Legacy blobs have no marker — they begin directly with a 12-byte IV — so a missing
     * marker means "encrypted with the previous key". That is what makes rotation safe: the
     * format itself says which key applies, so a half-migrated table is readable rather than
     * half-lost. Four bytes that no legacy IV can collide with by accident is cheap insurance;
     * the alternative is guessing, and a wrong guess on AES-GCM is indistinguishable from
     * corrupted data.
     */
    private static final byte[] MAGIC_V2 = { 'J', 'P', 'K', '2' };

    private static boolean hasMagic(byte[] b) {
        if (b == null || b.length < MAGIC_V2.length + IV_LEN) return false;
        for (int i = 0; i < MAGIC_V2.length; i++) {
            if (b[i] != MAGIC_V2[i]) return false;
        }
        return true;
    }

    /** True when this blob still needs re-encrypting under the current key. */
    public boolean isLegacy(byte[] stored) {
        return stored != null && stored.length > 0 && !hasMagic(stored);
    }

    /** True when a previous key is configured, i.e. a re-key is in progress or possible. */
    public boolean hasPreviousKey() {
        return previous != null;
    }

    public byte[] encrypt(byte[] plain) {
        try {
            byte[] iv = new byte[IV_LEN];
            random.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, primary, new GCMParameterSpec(TAG_BITS, iv));
            byte[] ct = c.doFinal(plain);
            byte[] out = new byte[MAGIC_V2.length + IV_LEN + ct.length];
            System.arraycopy(MAGIC_V2, 0, out, 0, MAGIC_V2.length);
            System.arraycopy(iv, 0, out, MAGIC_V2.length, IV_LEN);
            System.arraycopy(ct, 0, out, MAGIC_V2.length + IV_LEN, ct.length);
            return out;
        } catch (Exception e) {
            throw new IllegalStateException("encryption failed: " + e.getMessage(), e);
        }
    }

    /**
     * Decrypt under whichever key wrote this blob.
     *
     * Both keys are tried rather than trusting the marker alone. The marker says which key
     * SHOULD apply; trying the other afterwards costs one failed AES operation and rescues a
     * deployment that was half-rotated, or where the two variables were swapped — states that
     * would otherwise present as unreadable data with no way back.
     */
    public byte[] decrypt(byte[] stored) {
        boolean v2 = hasMagic(stored);
        int offset = v2 ? MAGIC_V2.length : 0;
        SecretKeySpec first = v2 ? primary : (previous != null ? previous : primary);
        SecretKeySpec second = (first == primary) ? previous : primary;
        try {
            return decryptWith(stored, offset, first);
        } catch (Exception firstFailure) {
            if (second != null) {
                try {
                    return decryptWith(stored, offset, second);
                } catch (Exception ignored) {
                    // Fall through to the original failure, which is the more informative one.
                }
            }
            throw new IllegalStateException("decryption failed: " + firstFailure.getMessage(),
                    firstFailure);
        }
    }

    private byte[] decryptWith(byte[] stored, int offset, SecretKeySpec k) throws Exception {
        byte[] iv = Arrays.copyOfRange(stored, offset, offset + IV_LEN);
        byte[] ct = Arrays.copyOfRange(stored, offset + IV_LEN, stored.length);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(TAG_BITS, iv));
        return c.doFinal(ct);
    }
}
