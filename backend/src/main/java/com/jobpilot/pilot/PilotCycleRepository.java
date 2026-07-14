package com.jobpilot.pilot;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PilotCycleRepository extends JpaRepository<PilotCycle, UUID> {
    List<PilotCycle> findByUserIdOrderByStartedAtDesc(UUID userId, Pageable page);
    Optional<PilotCycle> findFirstByUserIdAndStatusOrderByStartedAtDesc(UUID userId, String status);
}
