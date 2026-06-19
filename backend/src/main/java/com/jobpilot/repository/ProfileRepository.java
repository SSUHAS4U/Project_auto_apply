package com.jobpilot.repository;

import com.jobpilot.domain.Profile;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Optional;
import java.util.UUID;

public interface ProfileRepository extends JpaRepository<Profile, UUID> {
    Optional<Profile> findFirstByOrderByUpdatedAtAsc();
    Optional<Profile> findByUserId(UUID userId);

    @Modifying
    @Query("update Profile p set p.userId = :userId where p.userId is null")
    int claimOrphans(@Param("userId") UUID userId);
}
