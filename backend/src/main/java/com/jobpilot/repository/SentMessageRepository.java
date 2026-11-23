package com.jobpilot.repository;

import com.jobpilot.domain.SentMessage;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SentMessageRepository extends JpaRepository<SentMessage, UUID> {
    List<SentMessage> findByUserIdOrderByCreatedAtDesc(UUID userId, Pageable page);
    Optional<SentMessage> findByIdAndUserId(UUID id, UUID userId);
}
