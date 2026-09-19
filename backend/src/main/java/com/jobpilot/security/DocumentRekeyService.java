package com.jobpilot.security;

import com.jobpilot.domain.AppSecret;
import com.jobpilot.repository.AppSecretRepository;
import com.jobpilot.repository.DocumentRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Moves everything encrypted at rest onto the current key, once, safely.
 *
 * <h2>Why a migration and not a config change</h2>
 *
 * Until 2026-09-19 the at-rest key was derived from a string published in this public
 * repository. That key protects more than documents: the same {@link DocumentCrypto} encrypts
 * the API keys entered in the Admin UI (Groq, Gemini, Brevo) and the worker tokens. Simply
 * pointing the config at a new key would not re-encrypt anything — it would make every
 * existing row unreadable, and AES-GCM fails authentication rather than returning garbage, so
 * the damage would surface as "the app forgot my API keys", not as a crypto error.
 *
 * <h2>Why this is safe to run</h2>
 *
 * <ul>
 *   <li><b>Idempotent.</b> A row already carrying the current-key marker is skipped, so
 *       running it twice — or on every restart forever — does nothing after the first pass.</li>
 *   <li><b>Resumable.</b> Each row is its own transaction. An interruption leaves a mix of old
 *       and new rows, and the dual-key reader handles both, so a half-finished migration is a
 *       working system rather than a broken one.</li>
 *   <li><b>Never fatal.</b> A row that will not decrypt is logged and skipped. One damaged
 *       blob must not stop the backend or abandon the remaining rows.</li>
 *   <li><b>Read-verified.</b> Every rewritten blob is decrypted again and compared to the
 *       original bytes BEFORE the row is saved. A re-key that writes something unreadable is
 *       worse than no re-key at all, and this is the only way to know it did not.</li>
 * </ul>
 *
 * Once this reports nothing remaining, {@code JOBPILOT_DOC_KEY_PREVIOUS} can be removed from
 * the host. Until then it must stay: it is what reads the rows not yet migrated.
 */
@Service
public class DocumentRekeyService {

    private static final Logger log = LoggerFactory.getLogger(DocumentRekeyService.class);

    private final DocumentRepository documents;
    private final AppSecretRepository secrets;
    private final DocumentCrypto crypto;

    public DocumentRekeyService(DocumentRepository documents, AppSecretRepository secrets,
                                DocumentCrypto crypto) {
        this.documents = documents;
        this.secrets = secrets;
        this.crypto = crypto;
    }

    /**
     * Runs after startup, not during it.
     *
     * The application is already serving when this begins, so a slow or failing migration
     * degrades one background task instead of preventing the backend from booting. Nothing
     * here blocks a request: the dual-key reader means unmigrated rows work regardless.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void rekeyOnStartup() {
        if (!crypto.hasPreviousKey()) {
            // No previous key configured means there is nothing to migrate FROM.
            return;
        }
        try {
            Map<String, Object> r = rekeyAll();
            log.info("At-rest re-key: {}", r);
        } catch (Exception e) {
            log.error("At-rest re-key failed; data is unaffected and the dual-key reader still "
                    + "serves legacy rows. Cause: {}", e.getMessage(), e);
        }
    }

    /** @return per-store counts: migrated, already current, and failed. */
    public Map<String, Object> rekeyAll() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("documents", rekeyDocuments());
        out.put("secrets", rekeySecrets());
        return out;
    }

    private Map<String, Integer> rekeyDocuments() {
        int migrated = 0;
        int current = 0;
        int failed = 0;
        for (var id : documents.findAll().stream().map(com.jobpilot.domain.Document::getId).toList()) {
            try {
                Integer r = rekeyOneDocument(id);
                if (r == 1) migrated++;
                else current++;
            } catch (Exception e) {
                failed++;
                log.warn("Could not re-key document {}: {}", id, e.getMessage());
            }
        }
        return counts(migrated, current, failed);
    }

    /**
     * One row at a time, so an interruption cannot leave a partially written table.
     *
     * No @Transactional: this is called from another method of the same bean, so it never
     * passes through Spring's proxy and the annotation would be decoration — the same trap
     * that silently disabled it elsewhere in this codebase. The atomicity that matters is
     * per-row and comes from repository.save() carrying its own transaction; the row is only
     * saved after the round-trip check passes, so a failure leaves the original untouched.
     */
    protected Integer rekeyOneDocument(java.util.UUID id) {
        var doc = documents.findById(id).orElse(null);
        if (doc == null || doc.getData() == null || doc.getData().length == 0) return 0;
        if (!crypto.isLegacy(doc.getData())) return 0;

        byte[] plain = crypto.decrypt(doc.getData());
        byte[] reEncrypted = verifyRoundTrip(plain);
        doc.setData(reEncrypted);
        documents.save(doc);
        return 1;
    }

    private Map<String, Integer> rekeySecrets() {
        int migrated = 0;
        int current = 0;
        int failed = 0;
        for (String name : secrets.findAll().stream().map(AppSecret::getName).toList()) {
            try {
                Integer r = rekeyOneSecret(name);
                if (r == 1) migrated++;
                else current++;
            } catch (Exception e) {
                failed++;
                // Never log the name's VALUE, and the name alone is not sensitive.
                log.warn("Could not re-key stored secret '{}': {}", name, e.getMessage());
            }
        }
        return counts(migrated, current, failed);
    }

    /** Same per-row reasoning as rekeyOneDocument, and the same note about @Transactional. */
    protected Integer rekeyOneSecret(String name) {
        AppSecret s = secrets.findById(name).orElse(null);
        if (s == null || s.getValueEnc() == null || s.getValueEnc().isBlank()) return 0;

        byte[] stored = Base64.getDecoder().decode(s.getValueEnc());
        if (!crypto.isLegacy(stored)) return 0;

        byte[] plain = crypto.decrypt(stored);
        byte[] reEncrypted = verifyRoundTrip(plain);
        s.setValueEnc(Base64.getEncoder().encodeToString(reEncrypted));
        secrets.save(s);
        return 1;
    }

    /**
     * Encrypt, then decrypt what was just written and compare it to the original.
     *
     * Without this the migration would happily persist a blob it cannot read back, and the
     * only symptom would appear later, when the original key is gone and the data is
     * unrecoverable. The cost is one extra decrypt per row, paid once.
     */
    private byte[] verifyRoundTrip(byte[] plain) {
        byte[] out = crypto.encrypt(plain);
        byte[] check = crypto.decrypt(out);
        if (!java.util.Arrays.equals(plain, check)) {
            throw new IllegalStateException(
                    "re-encrypted blob did not decrypt back to the original — refusing to save it");
        }
        return out;
    }

    private static Map<String, Integer> counts(int migrated, int current, int failed) {
        Map<String, Integer> m = new LinkedHashMap<>();
        m.put("migrated", migrated);
        m.put("alreadyCurrent", current);
        m.put("failed", failed);
        return m;
    }

    /** How much is still on the old key — what tells the operator when it is safe to drop it. */
    public Map<String, Object> status() {
        long legacyDocs = documents.findAll().stream()
                .filter(d -> d.getData() != null && crypto.isLegacy(d.getData())).count();
        long legacySecrets = secrets.findAll().stream()
                .filter(s -> s.getValueEnc() != null && !s.getValueEnc().isBlank()
                        && crypto.isLegacy(Base64.getDecoder().decode(s.getValueEnc()))).count();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("previousKeyConfigured", crypto.hasPreviousKey());
        m.put("documentsOnOldKey", legacyDocs);
        m.put("secretsOnOldKey", legacySecrets);
        m.put("safeToRemovePreviousKey", legacyDocs == 0 && legacySecrets == 0);
        return m;
    }
}
