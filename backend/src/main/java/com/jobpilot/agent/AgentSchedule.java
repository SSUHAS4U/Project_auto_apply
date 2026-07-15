package com.jobpilot.agent;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** One portal block in the daily rotation (Naukri 09:00 for 120m, then LinkedIn, ...). */
@Getter
@Setter
@Entity
@Table(name = "agent_schedule")
public class AgentSchedule {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    private String portal;

    @Column(name = "ord", nullable = false)
    private int ord;

    /** "09:00" local; null means "immediately after the previous block". */
    @Column(name = "start_time")
    private String startTime;

    @Column(name = "duration_mins", nullable = false)
    private int durationMins = 120;

    @Column(columnDefinition = "text")
    private String keywords;

    @Column(columnDefinition = "text")
    private String locations;

    @Column(name = "apply_cap", nullable = false)
    private int applyCap = 200;

    @Column(name = "connect_cap", nullable = false)
    private int connectCap = 100;

    @Column(name = "message_cap", nullable = false)
    private int messageCap = 50;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
