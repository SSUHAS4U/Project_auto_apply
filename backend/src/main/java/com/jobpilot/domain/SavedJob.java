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

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private String raw;

    @Column(name = "promoted_job_id")
    private UUID promotedJobId;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();
}
