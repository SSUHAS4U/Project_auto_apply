package com.jobpilot.agent;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface AgentMessageRepository extends JpaRepository<AgentMessage, UUID> {

    List<AgentMessage> findByUserIdOrderByUpdatedAtDesc(UUID userId, Pageable page);

    List<AgentMessage> findByUserIdAndStatusOrderByUpdatedAtDesc(UUID userId, String status, Pageable page);

    List<AgentMessage> findByContactIdOrderByCreatedAtAsc(UUID contactId);

    long countByUserIdAndStatus(UUID userId, String status);
}
