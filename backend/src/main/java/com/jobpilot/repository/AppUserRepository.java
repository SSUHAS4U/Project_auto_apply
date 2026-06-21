package com.jobpilot.repository;

import com.jobpilot.domain.AppUser;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AppUserRepository extends JpaRepository<AppUser, UUID> {
    Optional<AppUser> findByEmailIgnoreCase(String email);
    boolean existsByEmailIgnoreCase(String email);

    List<AppUser> findAllByOrderByCreatedAtAsc();

    @Query("select u from AppUser u where lower(u.email) like concat('%', :q, '%') "
            + "or lower(coalesce(u.fullName, '')) like concat('%', :q, '%') order by u.createdAt")
    List<AppUser> search(@Param("q") String q);
}
