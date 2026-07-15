package com.jobpilot.engine;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** One /upskill gap-analysis report: skill heatmap + learning plan. */
@Getter
@Setter
@Entity
@Table(name = "engine_upskill")
public class EngineUpskill {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    /** JSON [{skill, demand, have}] for the heatmap grid. */
    @Column(columnDefinition = "text")
    private String heatmap;

    @Column(name = "report_md", columnDefinition = "text")
    private String reportMd;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();
}
