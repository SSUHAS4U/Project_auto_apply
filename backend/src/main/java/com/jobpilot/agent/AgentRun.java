package com.jobpilot.agent;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** One portal session the local worker runs (e.g. "Naukri, 09:00–11:00"). */
@Getter
@Setter
@Entity
@Table(name = "agent_run")
public class AgentRun {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    private String portal;

    /** queued | running | paused | needs_attention | done | failed */
    @Column(nullable = false)
    private String status = "queued";

    @Column(name = "current_action")
    private String currentAction;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "ended_at")
    private Instant endedAt;

    private int searched;
    private int evaluated;
    private int applied;
    private int connected;
    private int messaged;
    private int skipped;
    private int failed;

    @Column(columnDefinition = "text")
    private String note;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();
}
