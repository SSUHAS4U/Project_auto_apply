package com.jobpilot.agent;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.UUID;

/** Stores/serves the single latest live screenshot per user for the Watch Live panel. */
@Service
public class LiveFrameService {

    private final LiveFrameRepository repo;

    public LiveFrameService(LiveFrameRepository repo) {
        this.repo = repo;
    }

    @Transactional
    public void put(UUID userId, UUID runId, String portal, String action, String imageB64) {
        LiveFrame f = repo.findById(userId).orElseGet(() -> {
            LiveFrame n = new LiveFrame();
            n.setUserId(userId);
            return n;
        });
        f.setRunId(runId);
        f.setPortal(portal);
        f.setAction(action);
        if (imageB64 != null && !imageB64.isBlank()) f.setImageB64(imageB64);
        f.setUpdatedAt(Instant.now());
        repo.save(f);
    }

    public LiveFrame get(UUID userId) {
        return repo.findById(userId).orElse(null);
    }
}
