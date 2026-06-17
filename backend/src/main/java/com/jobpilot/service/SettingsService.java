package com.jobpilot.service;

import com.jobpilot.domain.AppSetting;
import com.jobpilot.repository.AppSettingRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
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
