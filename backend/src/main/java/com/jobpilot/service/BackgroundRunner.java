package com.jobpilot.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Runs long jobs (ingest across 60+ boards, the daily pipeline) off the request
 * thread so endpoints return instantly. One job at a time; completion is recorded
 * as a notification so the dashboard can surface it.
 */
@Service
public class BackgroundRunner {

    private static final Logger log = LoggerFactory.getLogger(BackgroundRunner.class);

    private final IngestService ingest;
    private final DailyService daily;
    private final NotificationService notifications;
    private final IngestProgress progress;

    private final ExecutorService pool = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "jobpilot-bg");
        t.setDaemon(true);
        return t;
    });
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicReference<String> last = new AtomicReference<>("idle");

    public BackgroundRunner(IngestService ingest, DailyService daily,
                            NotificationService notifications, IngestProgress progress) {
        this.ingest = ingest;
        this.daily = daily;
        this.notifications = notifications;
        this.progress = progress;
    }

    public Map<String, Object> startIngest() {
        return submit("ingest", () -> {
            try {
                IngestService.IngestResult r = ingest.run();
                notifications.create("ingest", "Ingest complete",
                        r.inserted() + " new jobs, " + r.updated() + " refreshed.",
                        Map.of("inserted", r.inserted(), "updated", r.updated(), "fetched", r.fetched()));
                return "ingest: +" + r.inserted() + " new";
            } catch (RuntimeException e) {
                progress.fail(e.getMessage());
                throw e;
            }
        });
    }

    public Map<String, Object> startRescore() {
        return submit("rescore", () -> {
            int n = ingest.rescoreAll();
            notifications.create("ingest", "Rescore complete", n + " jobs re-scored for your profile.", Map.of("rescored", n));
            return "rescored " + n + " jobs";
        });
    }

    public Map<String, Object> startDaily() {
        return submit("daily", () -> {
            Map<String, Object> r = daily.run();
            return "daily: " + r.get("topPicks") + " picks, +" + r.get("inserted") + " new";
        });
    }

    public Map<String, Object> status() {
        return Map.of("running", running.get(), "last", last.get());
    }

    private Map<String, Object> submit(String name, java.util.concurrent.Callable<String> task) {
        if (!running.compareAndSet(false, true)) {
            return Map.of("status", "busy", "message", "A run is already in progress.", "last", last.get());
        }
        last.set(name + " running…");
        pool.submit(() -> {
            long t0 = System.currentTimeMillis();
            try {
                String summary = task.call();
                last.set(summary + " (" + ((System.currentTimeMillis() - t0) / 1000) + "s)");
                log.info("Background {} done: {}", name, last.get());
            } catch (Exception e) {
                last.set(name + " failed: " + e.getMessage());
                log.warn("Background {} failed", name, e);
                notifications.create("ingest", name + " failed", e.getMessage(), Map.of());
            } finally {
                running.set(false);
            }
        });
        return Map.of("status", "started", "job", name,
                "message", "Started in the background — you'll get a notification when it finishes.");
    }
}
