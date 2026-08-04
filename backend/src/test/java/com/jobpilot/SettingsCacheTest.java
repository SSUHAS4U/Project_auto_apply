package com.jobpilot;

import com.jobpilot.domain.AppSetting;
import com.jobpilot.repository.AppSettingRepository;
import com.jobpilot.service.SettingsService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

/**
 * Settings are read on every worker poll, so they are cached. A cache that outlives a save is
 * worse than no cache: the owner presses Save, the value goes to the database, and the automation
 * keeps running on the old number with nothing to show why.
 */
class SettingsCacheTest {

    private AppSettingRepository repo;
    private SettingsService svc;
    private final List<AppSetting> rows = new ArrayList<>();

    private static AppSetting row(String k, String v) {
        AppSetting s = new AppSetting();
        s.setKey(k);
        s.setValue(v);
        return s;
    }

    @BeforeEach
    void setUp() {
        repo = Mockito.mock(AppSettingRepository.class);
        rows.clear();
        rows.add(row("agent_fit_min", "75"));
        when(repo.findAll()).thenAnswer(i -> new ArrayList<>(rows));
        when(repo.findById(anyString())).thenAnswer(i -> rows.stream()
                .filter(r -> r.getKey().equals(i.getArgument(0))).findFirst());
        when(repo.save(any())).thenAnswer(i -> i.getArgument(0));
        svc = new SettingsService(repo);
    }

    @Test
    void readingEverySettingCostsOneQueryNotOnePerKey() {
        svc.getAll();
        verify(repo, times(1)).findAll();
    }

    @Test
    void repeatedReadsInsideTheWindowHitTheCache() {
        for (int i = 0; i < 25; i++) svc.getAll();
        verify(repo, times(1)).findAll();      // 25 reads, one query
    }

    @Test
    void aSaveIsVisibleImmediately() {
        assertEquals("75", svc.getAll().get("agent_fit_min"));
        // Simulate the write landing in the table, as repo.save would.
        doAnswer(i -> {
            AppSetting s = i.getArgument(0);
            rows.removeIf(r -> r.getKey().equals(s.getKey()));
            rows.add(s);
            return s;
        }).when(repo).save(any());

        svc.put("agent_fit_min", "90");
        assertEquals("90", svc.getAll().get("agent_fit_min"),
                "a saved setting must not be masked by the cache");
    }

    @Test
    void aNewKeyIsVisibleImmediately() {
        svc.getAll();                                   // warm the cache without the key
        doAnswer(i -> { rows.add(i.getArgument(0)); return i.getArgument(0); }).when(repo).save(any());
        svc.put("agent_post_scan_target", "200");
        assertEquals("200", svc.getAll().get("agent_post_scan_target"));
    }

    @Test
    void invalidateForcesTheNextReadToHitTheDatabase() {
        svc.getAll();
        svc.invalidate();
        svc.getAll();
        verify(repo, times(2)).findAll();
    }

    @Test
    void aMissingOrBlankValueIsSimplyAbsent() {
        rows.add(row("blank_one", null));
        assertNull(svc.getAll().get("blank_one"));
        assertNull(svc.getAll().get("never_set"));
    }

    @Test
    void singleKeyGetStillWorksForCallersThatOnlyNeedOne() {
        assertEquals(Optional.of("75"), svc.get("agent_fit_min"));
    }
}
