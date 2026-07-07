package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

@Getter
@Setter
@Entity
@Table(name = "ats_source")
public class AtsSource {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    /** greenhouse | lever | ashby */
    @Column(nullable = false)
    private String provider;

    @Column(name = "board_token", nullable = false)
    private String boardToken;

    @Column(nullable = false)
    private String company;

    private boolean active = true;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();

    /** When the discovery job last probed this board's public API. */
    @Column(name = "last_checked_at")
    private Instant lastCheckedAt;

    /** Number of open jobs seen on the last probe. */
    @Column(name = "last_job_count")
    private Integer lastJobCount;

    /** Consecutive probe failures — the board is deactivated once this hits the limit. */
    @Column(name = "fail_count", nullable = false)
    private int failCount = 0;

    /** seed | probe — how this board entered the catalogue. */
    @Column(name = "discovered_via")
    private String discoveredVia;
}
