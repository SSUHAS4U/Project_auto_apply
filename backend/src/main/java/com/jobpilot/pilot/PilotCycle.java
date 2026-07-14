package com.jobpilot.pilot;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/**
 * One daily Pilot cycle — the automated equivalent of a /scrape + /rank + /apply
 * session in the ai-job-search framework.
 */
@Getter
@Setter
@Entity
@Table(name = "pilot_cycle")
public class PilotCycle {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id")
    private UUID userId;

    /** scheduled | manual */
    @Column(name = "run_trigger", nullable = false)
    private String trigger = "scheduled";

    /** running | completed | failed */
    @Column(nullable = false)
    private String status = "running";

    @Column(name = "started_at")
    private Instant startedAt = Instant.now();

    @Column(name = "finished_at")
    private Instant finishedAt;

    private int scanned;
    private int picked;
    private int evaluated;
    private int submitted;
    private int queued;
    private int skipped;
    private int failed;

    @Column(columnDefinition = "text")
    private String summary;

    @Column(columnDefinition = "text")
    private String error;
}
