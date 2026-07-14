package com.jobpilot.pilot;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface PilotJobRepository extends JpaRepository<PilotJob, UUID> {

    /**
     * Light projection for list views — never drags the PDF bytes or the full
     * artifact texts across the wire for a board of 100 cards.
     */
    interface Summary {
        UUID getId();
        UUID getCycleId();
        UUID getJobId();
        UUID getApplicationId();
        String getJobTitle();
        String getJobCompany();
        String getJobLocation();
        String getJobUrl();
        String getJobApplyType();
        Integer getMatchScore();
        String getStage();
        String getSkipReason();
        String getError();
        Integer getFitScore();
        String getVerdict();
        String getTailoringSummary();
        String getQueueStatus();
        Instant getCreatedAt();
        Instant getUpdatedAt();
    }

    List<Summary> findByUserIdOrderByUpdatedAtDesc(UUID userId, Pageable page);
    List<Summary> findByUserIdAndStageOrderByUpdatedAtDesc(UUID userId, String stage, Pageable page);
    List<Summary> findByCycleIdOrderByUpdatedAtDesc(UUID cycleId);
    List<Summary> findByUserIdAndQueueStatusOrderByFitScoreDesc(UUID userId, String queueStatus, Pageable page);

    /** Jobs still waiting in the backlog (seen but not yet picked into a cycle). */
    List<PilotJob> findByUserIdAndStageOrderByMatchScoreDesc(UUID userId, String stage, Pageable page);

    boolean existsByUserIdAndJobId(UUID userId, UUID jobId);
    long countByUserIdAndStageAndUpdatedAtAfter(UUID userId, String stage, Instant after);
    long countByUserIdAndQueueStatus(UUID userId, String queueStatus);

    /** Stage counts for the dashboard's pipeline board: [stage, count] rows. */
    @Query("select p.stage, count(p) from PilotJob p where p.userId = :userId group by p.stage")
    List<Object[]> countByStage(@Param("userId") UUID userId);

    /** Tracker-style dedup: has this company+role already been through the pipeline? */
    @Query("""
            select count(p) > 0 from PilotJob p
            where p.userId = :userId
              and lower(coalesce(p.jobCompany, '')) = lower(coalesce(:company, ''))
              and lower(coalesce(p.jobTitle, '')) = lower(coalesce(:title, ''))
            """)
    boolean existsByCompanyAndTitle(@Param("userId") UUID userId,
                                    @Param("company") String company,
                                    @Param("title") String title);
}
