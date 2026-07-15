package com.jobpilot.agent;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface AgentScheduleRepository extends JpaRepository<AgentSchedule, UUID> {

    List<AgentSchedule> findByUserIdOrderByOrdAsc(UUID userId);

    void deleteByUserId(UUID userId);
}
