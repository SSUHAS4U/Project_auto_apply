package com.jobpilot.repository;

import com.jobpilot.domain.DailyPick;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface DailyPickRepository extends JpaRepository<DailyPick, UUID> {
    List<DailyPick> findAllByOrderByRankAsc();
}
