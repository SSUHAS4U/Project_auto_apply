package com.jobpilot.engine;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface EngineUpskillRepository extends JpaRepository<EngineUpskill, UUID> {

    List<EngineUpskill> findByUserIdOrderByCreatedAtDesc(UUID userId);
}
