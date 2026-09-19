package com.jobpilot.repository;

import com.jobpilot.domain.DailyPick;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

public interface DailyPickRepository extends JpaRepository<DailyPick, UUID> {
    List<DailyPick> findAllByOrderByRankAsc();

    /** The curated set for one user, in the order the run ranked it. */
    List<DailyPick> findByUserIdOrderByRankAsc(UUID userId);

    /**
     * The set is REPLACED each run, so a run clears its own user's rows first.
     *
     * @Transactional here, not on the calling service method: the caller invokes it from
     * another method of the same bean, which does not pass through Spring's proxy, so an
     * annotation there is silently ignored and a derived delete then fails at runtime with
     * "No EntityManager with actual transaction available".
     */
    @Transactional
    @Modifying
    void deleteByUserId(UUID userId);
}
