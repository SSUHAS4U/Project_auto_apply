package com.jobpilot.repository;

import com.jobpilot.domain.SavedJob;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface SavedJobRepository extends JpaRepository<SavedJob, UUID> {
    List<SavedJob> findAllByOrderByCreatedAtDesc();
}
