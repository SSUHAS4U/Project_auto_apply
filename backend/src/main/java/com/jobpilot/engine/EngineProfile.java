package com.jobpilot.engine;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/**
 * The repo's profile files (CLAUDE.md + 01..07 + search-queries.md) as one row of
 * documents. /setup writes these; every other engine command reads them.
 */
@Getter
@Setter
@Entity
@Table(name = "engine_profile")
public class EngineProfile {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false, unique = true)
    private UUID userId;

    @Column(name = "candidate_md", columnDefinition = "text")
    private String candidateMd;

    @Column(name = "behavioral_md", columnDefinition = "text")
    private String behavioralMd;

    @Column(name = "writing_style_md", columnDefinition = "text")
    private String writingStyleMd;

    @Column(name = "evaluation_md", columnDefinition = "text")
    private String evaluationMd;

    @Column(name = "cv_template_latex", columnDefinition = "text")
    private String cvTemplateLatex;

    @Column(name = "cover_template_latex", columnDefinition = "text")
    private String coverTemplateLatex;

    @Column(name = "interview_prep_md", columnDefinition = "text")
    private String interviewPrepMd;

    /** JSON: {"keywords":[..], "locations":[..]} — the repo's search-queries.md. */
    @Column(name = "search_queries", columnDefinition = "text")
    private String searchQueries;

    @Column(name = "setup_log", columnDefinition = "text")
    private String setupLog;

    // ---- autopilot (daily self-running cycle) ----
    @Column(name = "auto_enabled", nullable = false)
    private boolean autoEnabled = false;

    @Column(name = "daily_cap", nullable = false)
    private int dailyCap = 15;

    @Column(name = "min_fit", nullable = false)
    private int minFit = 60;

    @Column(name = "last_run_at")
    private Instant lastRunAt;

    @Column(name = "last_run_summary", columnDefinition = "text")
    private String lastRunSummary;

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
