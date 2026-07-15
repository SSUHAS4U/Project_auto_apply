package com.jobpilot.agent;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** One atomic action the worker pulls and executes: apply / connect / message / search. */
@Getter
@Setter
@Entity
@Table(name = "agent_task")
public class AgentTask {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "run_id")
    private UUID runId;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    private String portal;

    /** apply | connect | message | search */
    @Column(nullable = false)
    private String kind;

    /** pending | in_progress | done | skipped | failed */
    @Column(nullable = false)
    private String status = "pending";

    @Column(name = "job_id")
    private UUID jobId;

    @Column(name = "application_id")
    private UUID applicationId;

    @Column(name = "job_title")
    private String jobTitle;

    @Column(name = "job_company")
    private String jobCompany;

    @Column(name = "job_location")
    private String jobLocation;

    @Column(name = "job_url")
    private String jobUrl;

    @Column(name = "match_score")
    private Integer matchScore;

    /** JSON: tailored resume ref, message body, prepared answers, etc. */
    @Column(columnDefinition = "text")
    private String payload;

    /** JSON: outcome details reported by the worker. */
    @Column(columnDefinition = "text")
    private String result;

    @Column(columnDefinition = "text")
    private String error;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
