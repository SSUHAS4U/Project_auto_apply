package com.jobpilot.repository;

import com.jobpilot.domain.AppSecret;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AppSecretRepository extends JpaRepository<AppSecret, String> {
}
