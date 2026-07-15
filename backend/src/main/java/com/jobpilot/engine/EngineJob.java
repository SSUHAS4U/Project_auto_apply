package com.jobpilot.engine;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** One scraped posting in the engine's own seen-store (/scrape) + tracker (/rank). */
@Getter
@Setter
@Entity
@Table(name = "engine_job")
public class EngineJob {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    private String source = "linkedin";

    @Column(name = "external_id")
    private String externalId;

    @Column(columnDefinition = "text")
    private String url;

    private String title;
    private String company;
    private String location;

    @Column(name = "posted_at")
    private String postedAt;

    @Column(columnDefinition = "text")
    private String description;

    @Column(name = "scraped_at")
    private Instant scrapedAt = Instant.now();

    /** new | ranked | shortlisted | applying | applied | dismissed | expired */
    @Column(nullable = false)
    private String status = "new";

    @Column(name = "fit_score")
    private Integer fitScore;

    private String verdict;

    @Column(columnDefinition = "text")
    private String strengths;

    @Column(columnDefinition = "text")
    private String gaps;

    /** Non-null = deal-breaker veto, with the reason (vetoes apply before scoring). */
    @Column(name = "deal_breaker", columnDefinition = "text")
    private String dealBreaker;

    private boolean urgent;

    @Column(name = "rank_notes", columnDefinition = "text")
    private String rankNotes;

    @Column(name = "content_hash", nullable = false)
    private String contentHash;
}
