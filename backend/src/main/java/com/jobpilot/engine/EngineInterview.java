package com.jobpilot.engine;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** A stage-specific interview prep pack built from the application's own archive. */
@Getter
@Setter
@Entity
@Table(name = "engine_interview")
public class EngineInterview {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "application_id")
    private UUID applicationId;

    @Column(name = "stage_label", nullable = false)
    private String stageLabel;

    @Column(name = "pack_md", columnDefinition = "text")
    private String packMd;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();
}
