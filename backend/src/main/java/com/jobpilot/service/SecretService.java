package com.jobpilot.service;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.AppSecret;
import com.jobpilot.repository.AppSecretRepository;
import com.jobpilot.security.DocumentCrypto;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Manages API keys/secrets entered from the Admin UI. Values are AES-256-GCM encrypted at rest
 * and NEVER returned to the client — the UI can only see whether each is configured, then
 * re-set or delete it. A DB-stored secret overrides the matching environment variable at runtime
 * (the properties bean is mutated live, so connectors/AI clients pick it up on their next call).
 */
@Service
public class SecretService {

    private static final Logger log = LoggerFactory.getLogger(SecretService.class);

    /** One managed secret: stable name, display label, group, and how it maps onto the live config. */
    private record Def(String name, String label, String group, Supplier<String> getter, Consumer<String> setter) {}

    private final AppSecretRepository repo;
    private final DocumentCrypto crypto;
    private final List<Def> defs;
    private final Map<String, Def> byName = new LinkedHashMap<>();
    private final Map<String, String> envDefaults = new HashMap<>();

    public SecretService(AppSecretRepository repo, DocumentCrypto crypto, JobPilotProperties props) {
        this.repo = repo;
        this.crypto = crypto;
        this.defs = List.of(
                new Def("groq.api_key", "Groq API key", "AI providers",
                        () -> props.getGroq().getApiKey(), v -> props.getGroq().setApiKey(v)),
                new Def("gemini.api_key", "Gemini API key", "AI providers",
                        () -> props.getGemini().getApiKey(), v -> props.getGemini().setApiKey(v)),
                new Def("gateway.url", "AI gateway URL (OmniRoute/OpenRouter /v1)", "AI providers",
                        () -> props.getGateway().getUrl(), v -> props.getGateway().setUrl(v)),
                new Def("gateway.api_key", "AI gateway key", "AI providers",
                        () -> props.getGateway().getApiKey(), v -> props.getGateway().setApiKey(v)),
                new Def("gateway.model", "AI gateway model (e.g. a :free model, or 'auto')", "AI providers",
                        () -> props.getGateway().getModel(), v -> props.getGateway().setModel(v)),
                new Def("brevo.api_key", "Brevo email API key", "Email",
                        () -> props.getMail().getBrevoApiKey(), v -> props.getMail().setBrevoApiKey(v)),
                new Def("adzuna.app_id", "Adzuna App ID", "Job sources",
                        () -> props.getAdzuna().getAppId(), v -> props.getAdzuna().setAppId(v)),
                new Def("adzuna.app_key", "Adzuna App Key", "Job sources",
                        () -> props.getAdzuna().getAppKey(), v -> props.getAdzuna().setAppKey(v)),
                new Def("careerjet.affid", "Careerjet Affiliate ID", "Job sources",
                        () -> props.getCareerjet().getAffid(), v -> props.getCareerjet().setAffid(v)),
                new Def("indianapi.api_key", "IndianAPI.in key", "Job sources",
                        () -> props.getIndianApi().getApiKey(), v -> props.getIndianApi().setApiKey(v)),
                new Def("jooble.key", "Jooble API key", "Job sources",
                        () -> props.getJooble().getKey(), v -> props.getJooble().setKey(v)));
        defs.forEach(d -> byName.put(d.name(), d));
    }

    /** Capture the env-provided values, then overlay any DB secrets, so deletes can revert to env. */
    @PostConstruct
    public void init() {
        for (Def d : defs) envDefaults.put(d.name(), nz(d.getter().get()));
        applyAll();
    }

    /** What the Admin UI shows — never any secret value, only whether/where each is configured. */
    public List<Map<String, Object>> status() {
        Set<String> saved = new HashSet<>();
        Map<String, Instant> when = new HashMap<>();
        for (AppSecret s : repo.findAll()) { saved.add(s.getName()); when.put(s.getName(), s.getUpdatedAt()); }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Def d : defs) {
            boolean inDb = saved.contains(d.name());
            boolean inEnv = !nz(envDefaults.get(d.name())).isBlank();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", d.name());
            m.put("label", d.label());
            m.put("group", d.group());
            m.put("configured", inDb || inEnv);
            m.put("source", inDb ? "saved" : (inEnv ? "env" : "none"));
            m.put("updatedAt", when.get(d.name()));
            out.add(m);
        }
        return out;
    }

    @Transactional
    public void set(String name, String value) {
        Def d = byName.get(name);
        if (d == null) throw new IllegalArgumentException("unknown secret: " + name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException("value is required");
        AppSecret s = repo.findById(name).orElseGet(AppSecret::new);
        s.setName(name);
        s.setValueEnc(encrypt(value.trim()));
        s.setUpdatedAt(Instant.now());
        repo.save(s);
        d.setter().accept(value.trim()); // live-apply
        log.info("Secret '{}' updated via admin UI", name);
    }

    @Transactional
    public void delete(String name) {
        Def d = byName.get(name);
        if (d == null) throw new IllegalArgumentException("unknown secret: " + name);
        repo.deleteById(name);
        d.setter().accept(envDefaults.get(name)); // revert to env (or blank)
        log.info("Secret '{}' deleted via admin UI", name);
    }

    /** Overlay every stored secret onto the live config (env stays where no secret is stored). */
    private void applyAll() {
        for (Def d : defs) {
            String db = repo.findById(d.name()).map(s -> safeDecrypt(s.getValueEnc())).orElse(null);
            d.setter().accept(db != null ? db : envDefaults.get(d.name()));
        }
    }

    private String encrypt(String plain) {
        return Base64.getEncoder().encodeToString(crypto.encrypt(plain.getBytes(StandardCharsets.UTF_8)));
    }

    private String safeDecrypt(String stored) {
        try {
            return new String(crypto.decrypt(Base64.getDecoder().decode(stored)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            log.warn("Could not decrypt a stored secret (key changed?): {}", e.getMessage());
            return null;
        }
    }

    private static String nz(String s) { return s == null ? "" : s; }
}
