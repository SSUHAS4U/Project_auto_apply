package com.jobpilot.repository;

import com.jobpilot.domain.Application;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ApplicationRepository extends JpaRepository<Application, UUID> {

    void deleteByUserId(UUID userId);
    List<Application> findAllByOrderByUpdatedAtDesc();
    List<Application> findByUserIdOrderByUpdatedAtDesc(UUID userId);
    List<Application> findByUserIdAndStatusOrderByUpdatedAtDesc(UUID userId, String status);
    Optional<Application> findFirstByUserIdAndJobId(UUID userId, UUID jobId);
    long countByUserIdAndMethodAndAppliedAtAfter(UUID userId, String method, Instant after);
    long countByUserId(UUID userId);

    @Modifying
    @Query("update Application a set a.userId = :userId where a.userId is null")
    int claimOrphans(@Param("userId") UUID userId);
}
