package com.jobpilot.repository;

import com.jobpilot.domain.ScoutedJob;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ScoutedJobRepository extends JpaRepository<ScoutedJob, UUID> {

    Optional<ScoutedJob> findByUrlHash(String urlHash);

    List<ScoutedJob> findByOrderByFetchedAtDescMatchScoreDesc(Pageable pageable);

    /**
     * @Transactional here rather than inherited from the caller: JobScoutService.run() used to
     * be @Transactional and this relied on it. That annotation was removed because the method
     * is mostly outbound HTTP, which would have left this modifying query with no transaction
     * and failing at runtime. It now carries its own and no longer depends on its caller.
     */
    @Transactional
    @Modifying
    @Query("delete from ScoutedJob s where s.fetchedAt < :cutoff")
    int deleteOlderThan(@Param("cutoff") Instant cutoff);
}
