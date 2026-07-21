package com.jobpilot.agent;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AgentRunRepository extends JpaRepository<AgentRun, UUID> {

    List<AgentRun> findByUserIdOrderByCreatedAtDesc(UUID userId, Pageable page);

    Optional<AgentRun> findFirstByUserIdAndStatusOrderByCreatedAtDesc(UUID userId, String status);

    Optional<AgentRun> findFirstByUserIdAndPortalAndStatusInOrderByCreatedAtDesc(
            UUID userId, String portal, List<String> statuses);

    /** Has this portal already had a run start within the current schedule window? */
    boolean existsByUserIdAndPortalAndCreatedAtGreaterThanEqual(UUID userId, String portal, Instant since);
}
