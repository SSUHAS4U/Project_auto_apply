package com.jobpilot.agent;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface AgentTaskRepository extends JpaRepository<AgentTask, UUID> {

    List<AgentTask> findByUserIdAndPortalAndStatusOrderByCreatedAtAsc(
            UUID userId, String portal, String status, Pageable page);

    List<AgentTask> findByRunIdOrderByCreatedAtAsc(UUID runId);

    long countByRunIdAndStatus(UUID runId, String status);

    boolean existsByUserIdAndJobUrl(UUID userId, String jobUrl);
}
