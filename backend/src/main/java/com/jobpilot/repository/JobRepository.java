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
     * Pilot scrape stage: fresh postings not yet in the pipeline backlog and not
     * already applied to — the seen_jobs.json + tracker dedup of the framework.
     */
    @Query(value = """
            select j.* from job j
            where j.fetched_at > :since
              and not exists (select 1 from application a
                              where a.job_id = j.id and a.user_id = :userId)
              and not exists (select 1 from pilot_job p
                              where p.job_id = j.id and p.user_id = :userId)
            order by j.match_score desc nulls last, j.fetched_at desc
            limit :lim
            """, nativeQuery = true)
    java.util.List<Job> findPilotCandidates(@Param("userId") UUID userId,
                                            @Param("since") Instant since,
                                            @Param("lim") int lim);

    /**
     * Delete stale jobs older than the cutoff — either not seen on any board since the
     * cutoff (fetched_at) OR POSTED before the cutoff (kills week-old postings even if a
     * board still lists them) — but never ones the user has acted on.
     */
    @Modifying
    @Query(value = """
            delete from job j
            where (j.fetched_at < :cutoff
                   or (j.posted_at is not null and j.posted_at < :cutoff))
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

    /** Remove duplicate jobs (same normalized company+title+city), keeping the newest unreferenced. */
    @Modifying
    @Query(value = """
            delete from job
            where id in (
              select id from (
                select id, row_number() over (
                  partition by
                    regexp_replace(lower(coalesce(company,'')), '[^a-z0-9]', '', 'g'),
                    regexp_replace(lower(coalesce(title,'')),   '[^a-z0-9]', '', 'g'),
                    regexp_replace(lower(split_part(coalesce(location,''), ',', 1)), '[^a-z0-9]', '', 'g')
                  order by fetched_at desc, id
                ) rn
                from job
              ) t where t.rn > 1
            )
            and not exists (select 1 from application a where a.job_id = job.id)
            and not exists (select 1 from saved_job s where s.promoted_job_id = job.id)
            """, nativeQuery = true)
    int deleteDuplicates();

    /** Wipe the whole job catalogue except jobs the user has tracked/promoted. */
    @Modifying
    @Query(value = """
            delete from job j
            where not exists (select 1 from application a where a.job_id = j.id)
              and not exists (select 1 from saved_job s where s.promoted_job_id = j.id)
            """, nativeQuery = true)
    int deleteAllUnreferenced();
}
