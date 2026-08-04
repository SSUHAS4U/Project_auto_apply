package com.jobpilot.service;

import com.jobpilot.domain.AppSetting;
import com.jobpilot.repository.AppSettingRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

@Service
public class SettingsService {

    private final AppSettingRepository repo;

    public SettingsService(AppSettingRepository repo) {
        this.repo = repo;
    }

    public Optional<String> get(String key) {
        return repo.findById(key).map(AppSetting::getValue);
    }

    /**
     * Every setting in ONE query.
     *
     * `get()` is a round-trip per key, which is fine for one lookup and awful for a screenful:
     * the automation settings alone are 23 keys, and the Schedule tab used to spend ~100
     * round-trips rendering — with the database in another region, seconds of it. Callers that
     * need several keys should read this map once instead.
     */
    public Map<String, String> getAll() {
        Map<String, String> hit = cache;
        if (hit != null && System.nanoTime() < cacheUntil) return hit;
        Map<String, String> out = new HashMap<>();
        for (AppSetting s : repo.findAll()) {
            if (s.getKey() != null) out.put(s.getKey(), s.getValue());
        }
        cache = out;
        cacheUntil = System.nanoTime() + CACHE_NANOS;
        return out;
    }

    /**
     * Settings are read constantly — the worker polls /next every ~4s, and each poll builds a
     * search plan — but they change only when someone presses Save. A few seconds of cache turns
     * that traffic into almost nothing, and {@link #put} clears it so a save is visible at once
     * rather than after the TTL.
     */
    private static final long CACHE_NANOS = 5_000_000_000L;   // 5s
    private volatile Map<String, String> cache;
    private volatile long cacheUntil;

    /** Drop the cache — called on every write so saved settings take effect immediately. */
    public void invalidate() {
        cache = null;
        cacheUntil = 0L;
    }

    @Transactional
    public void put(String key, String value) {
        AppSetting s = repo.findById(key).orElseGet(() -> {
            AppSetting n = new AppSetting();
            n.setKey(key);
            return n;
        });
        s.setValue(value);
        s.setUpdatedAt(Instant.now());
        repo.save(s);
        invalidate();   // a save must be visible on the very next read, not in 5 seconds
    }

    public Optional<Instant> getInstant(String key) {
        return repo.findById(key)
                .map(AppSetting::getValue)
                .filter(v -> v != null && !v.isBlank())
                .map(Instant::parse);
    }

    @Transactional
    public void setInstant(String key, Instant value) {
        AppSetting s = repo.findById(key).orElseGet(() -> {
            AppSetting n = new AppSetting();
            n.setKey(key);
            return n;
        });
        s.setValue(value == null ? null : value.toString());
        s.setUpdatedAt(Instant.now());
        repo.save(s);
    }
}
