package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** A job found by the automated scout (resume-keyword search across job sites). */
@Getter
@Setter
@Entity
@Table(name = "scouted_job")
public class ScoutedJob {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false)
    private String title;

    private String company;
    private String location;

    @Column(nullable = false)
    private String url;

    /** sha256(normalized url) — dedupe key across scout runs. */
    @Column(name = "url_hash", nullable = false, unique = true)
    private String urlHash;

    /** linkedin | naukri | indeed | google | jooble | careerjet | other */
    @Column(name = "source_site")
    private String sourceSite;

    @Column(columnDefinition = "text")
    private String snippet;

    /** Recruiter/apply emails found in the listing text (comma separated). */
    private String emails;

    /** Phone numbers found in the listing text (comma separated). */
    private String phones;

    /** Which of the resume keywords this listing matched (comma separated). */
    @Column(name = "matched_keywords")
    private String matchedKeywords;

    @Column(name = "match_score")
    private Integer matchScore;

    /** Freshness hint from the source ("2 days ago", ISO date…) when available. */
    @Column(name = "posted_hint")
    private String postedHint;

    @Column(name = "fetched_at", nullable = false)
    private Instant fetchedAt = Instant.now();

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();
}
