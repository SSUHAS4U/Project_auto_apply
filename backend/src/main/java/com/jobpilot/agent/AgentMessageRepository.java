package com.jobpilot.agent;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface AgentMessageRepository extends JpaRepository<AgentMessage, UUID> {

    @Modifying
    @Query("delete from AgentMessage m where m.userId = :userId")
    void deleteByUserId(@Param("userId") UUID userId);

    List<AgentMessage> findByUserIdOrderByUpdatedAtDesc(UUID userId, Pageable page);

    List<AgentMessage> findByUserIdAndStatusOrderByUpdatedAtDesc(UUID userId, String status, Pageable page);

    List<AgentMessage> findByContactIdOrderByCreatedAtAsc(UUID contactId);

    long countByUserIdAndStatus(UUID userId, String status);
}
