package com.jobpilot.repository;

import com.jobpilot.domain.ScoutedJob;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ScoutedJobRepository extends JpaRepository<ScoutedJob, UUID> {

    Optional<ScoutedJob> findByUrlHash(String urlHash);

    List<ScoutedJob> findByOrderByFetchedAtDescMatchScoreDesc(Pageable pageable);

    @Modifying
    @Query("delete from ScoutedJob s where s.fetchedAt < :cutoff")
    int deleteOlderThan(@Param("cutoff") Instant cutoff);
}
