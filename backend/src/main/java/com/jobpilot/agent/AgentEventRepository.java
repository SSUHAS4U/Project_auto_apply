package com.jobpilot.agent;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface AgentEventRepository extends JpaRepository<AgentEvent, UUID> {

    List<AgentEvent> findByUserIdOrderByCreatedAtDesc(UUID userId, Pageable page);

    List<AgentEvent> findByUserIdAndTypeOrderByCreatedAtDesc(UUID userId, String type, Pageable page);

    long countByUserIdAndTypeAndCreatedAtAfter(UUID userId, String type, Instant after);

    /** [type, count] since a cutoff — powers the dashboard metric cards in one query. */
    @Query("""
            select e.type, count(e) from AgentEvent e
            where e.userId = :userId and e.createdAt > :since
            group by e.type
            """)
    List<Object[]> countByTypeSince(@Param("userId") UUID userId, @Param("since") Instant since);
}
