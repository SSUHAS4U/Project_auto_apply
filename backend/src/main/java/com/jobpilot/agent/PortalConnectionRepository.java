package com.jobpilot.agent;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PortalConnectionRepository extends JpaRepository<PortalConnection, UUID> {

    List<PortalConnection> findByUserIdOrderByPortalAsc(UUID userId);

    Optional<PortalConnection> findByUserIdAndPortal(UUID userId, String portal);
}
