package com.jobpilot.repository;

import com.jobpilot.domain.SharedDoc;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SharedDocRepository extends JpaRepository<SharedDoc, String> {
}
