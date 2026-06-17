package com.jobpilot.repository;

import com.jobpilot.domain.Application;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ApplicationRepository extends JpaRepository<Application, UUID> {
    List<Application> findByStatusOrderByUpdatedAtDesc(String status);
    List<Application> findAllByOrderByUpdatedAtDesc();
    Optional<Application> findFirstByJobId(UUID jobId);
    long countByMethodAndAppliedAtAfter(String method, Instant after);
}
