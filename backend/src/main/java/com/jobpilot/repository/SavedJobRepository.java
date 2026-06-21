package com.jobpilot.repository;

import com.jobpilot.domain.SavedJob;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface SavedJobRepository extends JpaRepository<SavedJob, UUID> {
    List<SavedJob> findByUserIdOrderByCreatedAtDesc(UUID userId);
    long countByUserId(UUID userId);

    @Modifying
    @Query("update SavedJob s set s.userId = :userId where s.userId is null")
    int claimOrphans(@Param("userId") UUID userId);
}
