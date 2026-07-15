package com.jobpilot.engine;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface EngineApplicationRepository extends JpaRepository<EngineApplication, UUID> {

    /** List projection — never drags PDF bytes / full artifacts into board views. */
    interface Summary {
        UUID getId();
        UUID getJobId();
        String getPostingUrl();
        String getPostingTitle();
        String getPostingCompany();
        String getStage();
        Integer getFitScore();
        String getVerdict();
        String getOutcome();
        String getError();
        Instant getCreatedAt();
        Instant getUpdatedAt();
    }

    List<Summary> findByUserIdOrderByUpdatedAtDesc(UUID userId, Pageable page);

    List<Summary> findByUserIdAndStageOrderByUpdatedAtDesc(UUID userId, String stage, Pageable page);

    long countByUserIdAndStage(UUID userId, String stage);

    /** Autopilot daily budget: how many applications we already started today. */
    long countByUserIdAndCreatedAtAfter(UUID userId, java.time.Instant since);

    /** [stage, count] for the engine dashboard. */
    @Query("select a.stage, count(a) from EngineApplication a where a.userId = :userId group by a.stage")
    List<Object[]> countByStage(@Param("userId") UUID userId);
}
