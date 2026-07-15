package com.jobpilot.engine;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/**
 * One /apply run: parse → evaluate → draft → review → revise → compile (2-page rule
 * with relevance-weighted cutting) → ATS text-layer verify → ready/submitted.
 * Every artifact is archived — the repo's documents/applications/<company>_<role>/.
 */
@Getter
@Setter
@Entity
@Table(name = "engine_application")
public class EngineApplication {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "job_id")
    private UUID jobId;

    @Column(name = "posting_url", columnDefinition = "text")
    private String postingUrl;

    @Column(name = "posting_title")
    private String postingTitle;

    @Column(name = "posting_company")
    private String postingCompany;

    @Column(name = "posting_text", columnDefinition = "text")
    private String postingText;

    /** parsing | evaluating | drafting | reviewing | revising | compiling | verifying
     *  | ready | submitted | failed | vetoed */
    @Column(nullable = false)
    private String stage = "parsing";

    /** JSON [{stage, at, note}] — the visible timeline. */
    @Column(name = "stage_log", columnDefinition = "text")
    private String stageLog;

    /** JSON: 5-dimension fit + keywords + recommendation. */
    @Column(columnDefinition = "text")
    private String evaluation;

    @Column(name = "fit_score")
    private Integer fitScore;

    private String verdict;

    @Column(name = "cv_latex", columnDefinition = "text")
    private String cvLatex;

    @Column(name = "cover_latex", columnDefinition = "text")
    private String coverLatex;

    @Column(name = "reviewer_feedback", columnDefinition = "text")
    private String reviewerFeedback;

    @Column(name = "revision_notes", columnDefinition = "text")
    private String revisionNotes;

    @Column(name = "cut_report", columnDefinition = "text")
    private String cutReport;

    @Column(name = "ats_report", columnDefinition = "text")
    private String atsReport;

    @Column(name = "cv_pdf")
    private byte[] cvPdf;

    @Column(name = "cover_pdf")
    private byte[] coverPdf;

    @Column(name = "cv_pages")
    private Integer cvPages;

    @Column(name = "cover_pages")
    private Integer coverPages;

    @Column(columnDefinition = "text")
    private String error;

    /** /outcome: applied | interview_1 | interview_2 | offer | rejected | withdrawn */
    private String outcome;

    @Column(name = "outcome_notes", columnDefinition = "text")
    private String outcomeNotes;

    @Column(name = "outcome_at")
    private Instant outcomeAt;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
