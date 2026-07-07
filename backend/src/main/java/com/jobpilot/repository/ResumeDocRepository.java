package com.jobpilot.repository;

import com.jobpilot.domain.ResumeDoc;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ResumeDocRepository extends JpaRepository<ResumeDoc, UUID> {
    List<ResumeDoc> findByUserIdOrderByUpdatedAtDesc(UUID userId);
    Optional<ResumeDoc> findFirstByUserIdAndBaseTrue(UUID userId);
    Optional<ResumeDoc> findByIdAndUserId(UUID id, UUID userId);
}
