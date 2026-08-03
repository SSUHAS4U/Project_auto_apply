package com.jobpilot.agent;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AgentRunRepository extends JpaRepository<AgentRun, UUID> {

    @Modifying
    @Query("delete from AgentRun r where r.userId = :userId")
    void deleteByUserId(@Param("userId") UUID userId);

    List<AgentRun> findByUserIdOrderByCreatedAtDesc(UUID userId, Pageable page);

    Optional<AgentRun> findFirstByUserIdAndStatusOrderByCreatedAtDesc(UUID userId, String status);

    Optional<AgentRun> findFirstByUserIdAndPortalAndStatusInOrderByCreatedAtDesc(
            UUID userId, String portal, List<String> statuses);

    /** Has this portal already had a run start within the current schedule window? */
    boolean existsByUserIdAndPortalAndCreatedAtGreaterThanEqual(UUID userId, String portal, Instant since);

    /** The most recent run for a portal — used to alternate portals fairly. */
    Optional<AgentRun> findFirstByUserIdAndPortalOrderByCreatedAtDesc(UUID userId, String portal);

    /** How many runs this portal has had today — bounds outreach-only LinkedIn blocks. */
    long countByUserIdAndPortalAndCreatedAtGreaterThanEqual(UUID userId, String portal, Instant since);
}
