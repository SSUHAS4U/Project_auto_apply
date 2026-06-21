package com.jobpilot.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.repository.JobRepository;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Live + historical ingest metrics. The IngestService writes plain-English progress
 * here as it runs; the dashboard polls it. The last-run summary is persisted in
 * app_settings so "when did ingest last run" survives restarts.
 */
@Service
public class IngestProgress {

    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm:ss").withZone(java.time.ZoneOffset.UTC);
    private static final String K_SUMMARY = "last_ingest_summary";
    private static final int LOG_CAP = 300;

    private final SettingsService settings;
    private final JobRepository jobs;
    private final ObjectMapper mapper = new ObjectMapper();

    private final AtomicReference<String> status = new AtomicReference<>("idle"); // idle|running|done|error
    private volatile Instant startedAt;
    private volatile Instant finishedAt;
    private final List<String> log = Collections.synchronizedList(new ArrayList<>());
    private final Map<String, Integer> boards = new ConcurrentHashMap<>();
    private volatile int fetched, inserted, updated, sources, sourcesDone;

    public IngestProgress(SettingsService settings, JobRepository jobs) {
        this.settings = settings;
        this.jobs = jobs;
    }

    public void begin(int totalSources) {
        status.set("running");
        startedAt = Instant.now();
        finishedAt = null;
        fetched = inserted = updated = sourcesDone = 0;
        sources = totalSources;
        boards.clear();
        synchronized (log) { log.clear(); }
        line("Ingest initiated — scanning " + totalSources + " job sources.");
    }

    /** A source finished fetching: record its plain-English line + counts. */
    public void source(String name, int count) {
        sourcesDone++;
        if (name != null && !name.isBlank()) boards.merge(name, count, Integer::sum);
        if (count > 0) line("Collected " + count + " job" + (count == 1 ? "" : "s") + " from " + (name == null ? "a source" : name) + ".");
    }

    public void counts(int fetched, int inserted, int updated) {
        this.fetched = fetched; this.inserted = inserted; this.updated = updated;
    }

    public void note(String msg) { line(msg); }

    public void finish(int fetched, int inserted, int updated, int totalJobs) {
        this.fetched = fetched; this.inserted = inserted; this.updated = updated;
        finishedAt = Instant.now();
        status.set("done");
        long secs = startedAt == null ? 0 : Duration.between(startedAt, finishedAt).getSeconds();
        line("Complete — added " + inserted + " new, refreshed " + updated
                + " existing, scanned " + fetched + " listings in " + secs + "s. Board now holds " + totalJobs + " jobs.");
        persistSummary(totalJobs, secs);
    }

    public void fail(String err) {
        finishedAt = Instant.now();
        status.set("error");
        line("Ingest failed: " + err);
    }

    private void line(String msg) {
        synchronized (log) {
            log.add(CLOCK.format(Instant.now()) + "  " + msg);
            while (log.size() > LOG_CAP) log.remove(0);
        }
    }

    /** Full live snapshot for admins (status, log, per-board, memory). */
    public Map<String, Object> snapshot() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("status", status.get());
        m.put("running", "running".equals(status.get()));
        m.put("startedAt", startedAt == null ? null : startedAt.toString());
        m.put("finishedAt", finishedAt == null ? null : finishedAt.toString());
        m.put("fetched", fetched);
        m.put("inserted", inserted);
        m.put("updated", updated);
        m.put("sources", sources);
        m.put("sourcesDone", sourcesDone);
        synchronized (log) { m.put("log", new ArrayList<>(log)); }
        List<Map<String, Object>> board = new ArrayList<>();
        boards.entrySet().stream()
                .sorted((a, b) -> b.getValue() - a.getValue())
                .forEach(e -> board.add(Map.of("source", e.getKey(), "count", e.getValue())));
        m.put("boards", board);
        m.put("totalJobs", safeCount());
        m.put("memory", memory());
        m.put("lastRun", lastSummary());
        return m;
    }

    /** Lightweight last-run summary for every user (top-of-board text). */
    public Map<String, Object> summary() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("running", "running".equals(status.get()));
        m.put("totalJobs", safeCount());
        m.put("lastRun", lastSummary());
        return m;
    }

    private Map<String, Object> memory() {
        Runtime rt = Runtime.getRuntime();
        long mb = 1024 * 1024;
        long used = (rt.totalMemory() - rt.freeMemory()) / mb;
        long committed = rt.totalMemory() / mb;
        long max = rt.maxMemory() / mb;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("usedMb", used);
        m.put("committedMb", committed);
        m.put("maxMb", max);
        m.put("usedPct", max > 0 ? Math.round(used * 100.0 / max) : 0);
        return m;
    }

    private void persistSummary(int totalJobs, long secs) {
        try {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("finishedAt", finishedAt.toString());
            s.put("inserted", inserted);
            s.put("updated", updated);
            s.put("fetched", fetched);
            s.put("totalJobs", totalJobs);
            s.put("durationSec", secs);
            settings.put(K_SUMMARY, mapper.writeValueAsString(s));
        } catch (Exception ignored) { /* metrics are best-effort */ }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> lastSummary() {
        return settings.get(K_SUMMARY).filter(s -> !s.isBlank()).map(s -> {
            try { return (Map<String, Object>) mapper.readValue(s, Map.class); }
            catch (Exception e) { return null; }
        }).orElse(null);
    }

    private long safeCount() {
        try { return jobs.count(); } catch (Exception e) { return -1; }
    }
}
