package com.jobpilot.engine;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface EngineInterviewRepository extends JpaRepository<EngineInterview, UUID> {

    List<EngineInterview> findByUserIdOrderByCreatedAtDesc(UUID userId);

    List<EngineInterview> findByApplicationIdOrderByCreatedAtDesc(UUID applicationId);
}
