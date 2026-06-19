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

    /** Remove non-tech listings (sales/VKYC/ops/etc.) that the user hasn't acted on. */
    @Modifying
    @Query(value = """
            delete from job j
            where not exists (select 1 from application a where a.job_id = j.id)
              and not exists (select 1 from saved_job s where s.promoted_job_id = j.id)
              and (
                j.title ~* '(vkyc|v-kyc|\\mkyc\\M|telecall|tele caller|\\mbpo\\M|business development|relationship manager|collection|recovery|field (executive|sales)|\\mdriver\\M|warehouse|\\mnurse\\M|accountant|recruit(er|ment)|talent acquisition|content writer|customer care|voice process|non.?voice|data entry|back office|cashier|teller|\\mbde\\M|inside sales|territory|store manager|beautician|chef|security guard|housekeeping)'
                OR j.title !~* '(developer|engineer|software|programmer|\\msde\\M|\\msdet\\M|devops|\\msre\\M|data scien|data engineer|data analyst|machine learning|full ?stack|front ?end|back ?end|\\mjava\\M|python|javascript|typescript|react|angular|node|golang|kotlin|swift|android|\\mios\\M|flutter|\\mqa\\M|automation|cloud|kubernetes|docker|database|\\mdba\\M|web developer|technical|computer|architect|platform|security engineer|firmware|embedded|analytics|systems engineer|network engineer|solutions engineer|\\mui\\M|\\mux\\M|infrastructure|\\mapi\\M|microservice)'
              )
            """, nativeQuery = true)
    int deleteNonTechUnreferenced();
}
