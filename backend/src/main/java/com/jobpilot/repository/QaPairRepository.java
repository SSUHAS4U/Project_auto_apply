package com.jobpilot.repository;

import com.jobpilot.domain.QaPair;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface QaPairRepository extends JpaRepository<QaPair, UUID> {

    List<QaPair> findByUserIdOrderByUpdatedAtDesc(UUID userId);

    Optional<QaPair> findByUserIdAndQuestionKey(UUID userId, String questionKey);
}
