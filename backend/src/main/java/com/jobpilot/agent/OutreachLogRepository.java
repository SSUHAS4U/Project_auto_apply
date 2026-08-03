package com.jobpilot.agent;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.UUID;

public interface OutreachLogRepository extends JpaRepository<OutreachLog, UUID> {

    /** Idempotency: has this exact company+role+recruiter+résumé combination been sent already? */
    boolean existsByUserIdAndOutreachHash(UUID userId, String outreachHash);

    /** Per-company throttle. */
    long countByUserIdAndCompanyAndCreatedAtGreaterThanEqual(UUID userId, String company, Instant since);

    /** Per-recruiter throttle — same person, any role. */
    long countByUserIdAndRecruiterUrlAndCreatedAtGreaterThanEqual(UUID userId, String recruiterUrl, Instant since);

    /** Overall daily volume. */
    long countByUserIdAndCreatedAtGreaterThanEqual(UUID userId, Instant since);

    @Modifying
    @Query("delete from OutreachLog o where o.userId = :userId")
    void deleteByUserId(@Param("userId") UUID userId);
}
