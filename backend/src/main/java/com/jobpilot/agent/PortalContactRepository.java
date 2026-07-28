package com.jobpilot.agent;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PortalContactRepository extends JpaRepository<PortalContact, UUID> {

    @Modifying
    @Query("delete from PortalContact c where c.userId = :userId")
    void deleteByUserId(@Param("userId") UUID userId);

    List<PortalContact> findByUserIdOrderByUpdatedAtDesc(UUID userId, Pageable page);

    List<PortalContact> findByUserIdAndConnectionStatusOrderByUpdatedAtDesc(
            UUID userId, String connectionStatus, Pageable page);

    Optional<PortalContact> findByUserIdAndPortalAndProfileUrl(UUID userId, String portal, String profileUrl);

    Optional<PortalContact> findFirstByUserIdAndEmailIgnoreCase(UUID userId, String email);
}
