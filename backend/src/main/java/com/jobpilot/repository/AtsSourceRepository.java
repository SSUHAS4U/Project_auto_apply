package com.jobpilot.repository;

import com.jobpilot.domain.AtsSource;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AtsSourceRepository extends JpaRepository<AtsSource, UUID> {
    List<AtsSource> findByActiveTrue();
    Optional<AtsSource> findByProviderAndBoardToken(String provider, String boardToken);
}
