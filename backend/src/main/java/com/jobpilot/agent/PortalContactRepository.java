package com.jobpilot.agent;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PortalContactRepository extends JpaRepository<PortalContact, UUID> {

    List<PortalContact> findByUserIdOrderByUpdatedAtDesc(UUID userId, Pageable page);

    List<PortalContact> findByUserIdAndConnectionStatusOrderByUpdatedAtDesc(
            UUID userId, String connectionStatus, Pageable page);

    Optional<PortalContact> findByUserIdAndPortalAndProfileUrl(UUID userId, String portal, String profileUrl);
}
