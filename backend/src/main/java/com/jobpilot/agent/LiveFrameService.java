package com.jobpilot.agent;

import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Stores/serves the single latest live screenshot per user for the Watch Live panel.
 *
 * IN-MEMORY ONLY — deliberately NOT persisted. Live frames are transient (only the latest
 * one matters) and arrive ~1/second while a run is active. Writing each one to the database
 * was the single biggest source of network egress (the DB is in another region, so every
 * frame was crossing the internet twice — once to store, once to read back). Keeping the
 * latest frame in a ConcurrentHashMap removes ALL of that DB traffic, makes Watch Live
 * snappier, and keeps the database small. The VM is a single instance, so a map is all we
 * need; frames are simply gone after a restart, which is fine for a live view.
 */
@Service
public class LiveFrameService {

    private final ConcurrentHashMap<UUID, LiveFrame> frames = new ConcurrentHashMap<>();

    public void put(UUID userId, UUID runId, String portal, String action, String imageB64) {
        // Build a fresh frame and swap it in atomically (map.put) so readers never see a
        // half-updated object. Action-only updates (no new image) keep the last image.
        LiveFrame f = new LiveFrame();
        f.setUserId(userId);
        f.setRunId(runId);
        f.setPortal(portal);
        f.setAction(action);
        if (imageB64 != null && !imageB64.isBlank()) {
            f.setImageB64(imageB64);
        } else {
            LiveFrame prev = frames.get(userId);
            if (prev != null) f.setImageB64(prev.getImageB64());
        }
        f.setUpdatedAt(Instant.now());
        frames.put(userId, f);
    }

    public LiveFrame get(UUID userId) {
        return frames.get(userId);
    }
}
