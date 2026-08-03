package com.jobpilot.agent;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface AgentEventRepository extends JpaRepository<AgentEvent, UUID> {

    // Bulk DELETE in one SQL statement. The derived deleteByUserId loaded every row and deleted
    // it one at a time — on a user with thousands of events (the same job across every city
    // search) that hung the "Reset automation data" request on the tiny VM.
    @Modifying
    @Query("delete from AgentEvent e where e.userId = :userId")
    void deleteByUserId(@Param("userId") UUID userId);

    List<AgentEvent> findByUserIdOrderByCreatedAtDesc(UUID userId, Pageable page);

    List<AgentEvent> findByUserIdAndTypeOrderByCreatedAtDesc(UUID userId, String type, Pageable page);

    long countByUserIdAndTypeAndCreatedAtAfter(UUID userId, String type, Instant after);

    /** How many applications went out on ONE portal since a cutoff — powers the daily quota. */
    @Query("""
            select count(e) from AgentEvent e
            where e.userId = :userId and e.portal = :portal
              and e.type in ('applied', 'easy_apply') and e.createdAt > :since
            """)
    long countAppliedSince(@Param("userId") UUID userId, @Param("portal") String portal,
                           @Param("since") Instant since);

    /** [type, count] since a cutoff — powers the dashboard metric cards in one query. */
    @Query("""
            select e.type, count(e) from AgentEvent e
            where e.userId = :userId and e.createdAt > :since
            group by e.type
            """)
    List<Object[]> countByTypeSince(@Param("userId") UUID userId, @Param("since") Instant since);
}
