package com.jobpilot.repository;

import com.jobpilot.domain.Notification;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface NotificationRepository extends JpaRepository<Notification, UUID> {
    List<Notification> findByUserIdAndReadFalseOrderByCreatedAtDesc(UUID userId);
    List<Notification> findByUserIdOrderByCreatedAtDesc(UUID userId);
    long countByUserIdAndReadFalse(UUID userId);

    @Modifying
    @Query("update Notification n set n.userId = :userId where n.userId is null")
    int claimOrphans(@Param("userId") UUID userId);
}
