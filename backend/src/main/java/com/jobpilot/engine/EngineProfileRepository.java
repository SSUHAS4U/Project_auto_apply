package com.jobpilot.engine;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface EngineProfileRepository extends JpaRepository<EngineProfile, UUID> {
    Optional<EngineProfile> findByUserId(UUID userId);

    /** Autopilot: every profile that opted into the daily self-running cycle. */
    List<EngineProfile> findByAutoEnabledTrue();
}
