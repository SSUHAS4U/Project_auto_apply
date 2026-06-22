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

    public DocumentCrypto(JobPilotProperties props) {
        // Prefer a dedicated key; fall back to the JWT secret so encryption always works.
        String secret = props.getDocKey() != null && !props.getDocKey().isBlank()
                ? props.getDocKey()
                : props.getJwt().getSecret();
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
