package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

@Getter
@Setter
@Entity
@Table(name = "daily_pick")
public class DailyPick {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "job_id")
    private UUID jobId;

    private Integer rank;

    @Column(name = "run_at")
    private Instant runAt = Instant.now();

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();
}
