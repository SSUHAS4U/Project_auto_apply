package com.jobpilot.security;

import com.jobpilot.config.JobPilotProperties;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Rotating the at-rest key must never make existing data unreadable.
 *
 * That is not a theoretical worry here: before the version marker existed, changing the key
 * destroyed every stored document and API key, and AES-GCM's authentication failure meant it
 * surfaced as "the app forgot my keys" rather than as a crypto error anyone would trace back.
 * These tests encrypt under an old key, rotate, and read — the actual sequence.
 */
class DocumentCryptoRotationTest {

    private static final String REMOTE = "jdbc:postgresql://db.example.com:5432/postgres";
    private static final String OLD = "change-me-jobpilot-dev-jwt-secret";
    private static final String NEW = "Zk8rT2pLqW4vXnB7yH3sMd9cF1aQeR6uJiO0lPzA5tGv";

    private DocumentCrypto crypto(String docKey, String previous) {
        JobPilotProperties p = new JobPilotProperties();
        p.setDocKey(docKey);
        p.setDocKeyPrevious(previous);
        return new DocumentCrypto(p, REMOTE);
    }

    @Test
    void dataEncryptedUnderTheOldKeyStillReadsAfterRotation() {
        byte[] secret = "my résumé bytes — €100k".getBytes(java.nio.charset.StandardCharsets.UTF_8);

        // Written before the rotation, by the old build: no version marker.
        DocumentCrypto before = crypto(OLD, "");
        byte[] stored = before.encrypt(secret);

        // Simulate the pre-marker format the old build actually produced.
        byte[] legacy = java.util.Arrays.copyOfRange(stored, 4, stored.length);

        DocumentCrypto after = crypto(NEW, OLD);
        assertArrayEquals(secret, after.decrypt(legacy),
                "a blob written under the old key must still read after rotation");
        assertTrue(after.isLegacy(legacy), "and must be reported as still needing migration");
    }

    @Test
    void newWritesUseTheNewKeyAndAreNotFlaggedLegacy() {
        DocumentCrypto after = crypto(NEW, OLD);
        byte[] out = after.encrypt("fresh".getBytes());
        assertFalse(after.isLegacy(out));
        assertArrayEquals("fresh".getBytes(), after.decrypt(out));
    }

    @Test
    void onceMigratedTheOldKeyCanBeRemoved() {
        DocumentCrypto during = crypto(NEW, OLD);
        byte[] migrated = during.encrypt("payload".getBytes());

        // The operator drops JOBPILOT_DOC_KEY_PREVIOUS after the migration reports clean.
        DocumentCrypto afterCleanup = crypto(NEW, "");
        assertArrayEquals("payload".getBytes(), afterCleanup.decrypt(migrated));
        assertFalse(afterCleanup.hasPreviousKey());
    }

    @Test
    void rotatingWithoutKeepingTheOldKeyIsWhatDestroysData() {
        // The failure mode this whole design exists to prevent, asserted so nobody "simplifies"
        // the previous-key handling away without seeing what it costs.
        byte[] stored = crypto(OLD, "").encrypt("irreplaceable".getBytes());
        byte[] legacy = java.util.Arrays.copyOfRange(stored, 4, stored.length);

        DocumentCrypto rotatedCarelessly = crypto(NEW, "");
        assertThrows(IllegalStateException.class, () -> rotatedCarelessly.decrypt(legacy),
                "without the previous key the old blob is gone — this is the data-loss case");
    }

    @Test
    void swappedKeysStillRead() {
        // A deployment that puts the keys in the wrong variables is a configuration mistake,
        // not a reason to lose data. Both are tried, so it recovers.
        DocumentCrypto right = crypto(NEW, OLD);
        byte[] blob = right.encrypt("value".getBytes());
        DocumentCrypto swapped = crypto(OLD, NEW);
        assertArrayEquals("value".getBytes(), swapped.decrypt(blob));
    }

    @Test
    void aMarkerIsNotMistakenForRealCiphertext() {
        // isLegacy() decides whether a row gets rewritten. A false "already current" would skip
        // a row forever and leave it on the old key after the key is gone.
        DocumentCrypto c = crypto(NEW, OLD);
        assertTrue(c.isLegacy(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 }));
        assertFalse(c.isLegacy(new byte[0]), "an empty blob has nothing to migrate");
        assertFalse(c.isLegacy(null));
    }
}
