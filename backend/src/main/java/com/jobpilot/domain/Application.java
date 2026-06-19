package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

@Getter
@Setter
@Entity
@Table(name = "application")
public class Application {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id")
    private UUID userId;

    @Column(name = "job_id")
    private UUID jobId;

    /** interested | applied | interviewing | offer | rejected | withdrawn */
    @Column(nullable = false)
    private String status = "interested";

    /** email | extension | manual */
    private String method;

    @Column(name = "applied_at")
    private Instant appliedAt;

    @Column(name = "cover_letter", columnDefinition = "text")
    private String coverLetter;

    @Column(name = "resume_version")
    private String resumeVersion;

    @Column(columnDefinition = "text")
    private String notes;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
