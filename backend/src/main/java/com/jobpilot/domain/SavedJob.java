package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Getter
@Setter
@Entity
@Table(name = "saved_job")
public class SavedJob {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id")
    private UUID userId;

    private String title;
    private String company;
    private String location;

    @Column(nullable = false)
    private String url;

    @Column(name = "source_site")
    private String sourceSite;

    /** The posting text the extension scraped. Null for anything captured before V39 — the
     *  card renders those compactly rather than printing "Not mentioned" for every fact. */
    @Column(columnDefinition = "text")
    private String description;

    /** Scored against the profile on capture, so a saved listing shows the same fit panel as
     *  a board listing. Null when there is no description or no profile skills to score on. */
    @Column(name = "match_score")
    private Integer matchScore;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private String raw;

    @Column(name = "promoted_job_id")
    private UUID promotedJobId;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();
}
