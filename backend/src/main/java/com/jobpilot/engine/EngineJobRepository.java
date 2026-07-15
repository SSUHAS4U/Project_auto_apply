package com.jobpilot.engine;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface EngineJobRepository extends JpaRepository<EngineJob, UUID> {

    List<EngineJob> findByUserIdOrderByScrapedAtDesc(UUID userId, Pageable page);

    List<EngineJob> findByUserIdAndStatusOrderByScrapedAtDesc(UUID userId, String status, Pageable page);

    /** Autopilot picks the best-fit shortlisted jobs to apply to. */
    List<EngineJob> findByUserIdAndStatusOrderByFitScoreDesc(UUID userId, String status, Pageable page);

    /** Ranked view: best fits first, unranked last. */
    @Query("""
            select j from EngineJob j where j.userId = :userId and j.status <> 'dismissed'
            order by case when j.fitScore is null then -1 else j.fitScore end desc, j.scrapedAt desc
            """)
    List<EngineJob> findRanked(@Param("userId") UUID userId, Pageable page);

    boolean existsByUserIdAndContentHash(UUID userId, String contentHash);

    long countByUserIdAndStatus(UUID userId, String status);

    /** [status, count] for the engine dashboard. */
    @Query("select j.status, count(j) from EngineJob j where j.userId = :userId group by j.status")
    List<Object[]> countByStatus(@Param("userId") UUID userId);
}
