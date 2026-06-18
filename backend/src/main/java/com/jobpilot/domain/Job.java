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
@Table(name = "job")
public class Job {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false)
    private String source;

    @Column(name = "source_job_id")
    private String sourceJobId;

    @Column(nullable = false)
    private String title;

    private String company;
    private String location;
    private boolean remote;

    @Column(columnDefinition = "text")
    private String description;

    @Column(nullable = false)
    private String url;

    /** email | url | ats | unknown */
    @Column(name = "apply_type", nullable = false)
    private String applyType = "url";

    @Column(name = "apply_email")
    private String applyEmail;

    @Column(name = "salary_text")
    private String salaryText;

    @Column(name = "posted_at")
    private Instant postedAt;

    @Column(name = "fetched_at")
    private Instant fetchedAt = Instant.now();

    @Column(name = "content_hash", nullable = false, unique = true)
    private String contentHash;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private String raw;

    @Column(name = "match_score")
    private Integer matchScore;

    /** india | outside | remote | unknown — for the Jobs board split. */
    private String region;
}
