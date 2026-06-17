package com.jobpilot.repository;

import com.jobpilot.domain.Job;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

public interface JobRepository extends JpaRepository<Job, UUID>, JpaSpecificationExecutor<Job> {
    Optional<Job> findByContentHash(String contentHash);
    long countByFetchedAtAfter(Instant after);

    /**
     * Delete stale jobs older than the cutoff, but never ones the user has acted
     * on (tracked applications) or promoted from a saved listing.
     */
    @Modifying
    @Query(value = """
            delete from job j
            where j.fetched_at < :cutoff
              and not exists (select 1 from application a where a.job_id = j.id)
              and not exists (select 1 from saved_job s where s.promoted_job_id = j.id)
            """, nativeQuery = true)
    int deleteStaleUnreferenced(@Param("cutoff") Instant cutoff);
}
