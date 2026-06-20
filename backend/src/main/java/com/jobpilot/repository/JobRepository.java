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

    /** Remove non-software listings (support/ops/sales/design/VKYC/etc.) the user hasn't acted on. */
    @Modifying
    @Query(value = """
            delete from job j
            where not exists (select 1 from application a where a.job_id = j.id)
              and not exists (select 1 from saved_job s where s.promoted_job_id = j.id)
              and (
                j.title ~* '(vkyc|v-kyc|\\ykyc\\y|telecall|tele.?caller|\\ybpo\\y|business development|\\ybde\\y|relationship manager|collection|recovery|field (executive|sales|officer)|\\ydriver\\y|warehouse|\\ynurse\\y|accountant|recruit(er|ment)|talent acquisition|content writer|voice process|non.?voice|data entry|back office|cashier|teller|inside sales|territory|store manager|housekeeping|support (engineer|associate|specialist|analyst|operations|technician|representative)|(customer|technical|product|designated|application) support|\\yoperations\\y|service delivery|\\ydesigner\\y|product manager|program manager|project manager|scrum master|account manager|business analyst|customer success|\\ymarketing\\y|\\ysales\\y|presales|pre.?sales|consultant|implementation)'
                OR j.title !~* '(software (engineer|developer)|\\ysde\\y|\\ysdet\\y|backend|back.?end|frontend|front.?end|full.?stack|web developer|application (developer|engineer)|mobile (developer|engineer)|android|\\yios\\y|\\ydeveloper\\y|programmer|devops|\\ysre\\y|site reliability|platform engineer|cloud engineer|infrastructure engineer|data (engineer|scientist)|machine learning|\\yml engineer\\y|mlops|ai engineer|security engineer|qa engineer|test (engineer|automation)|embedded|firmware|blockchain|\\yjava\\y|python|javascript|typescript|\\yreact\\y|angular|node|golang|kotlin|spring boot)'
              )
            """, nativeQuery = true)
    int deleteNonTechUnreferenced();
}
