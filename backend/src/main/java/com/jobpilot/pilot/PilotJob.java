package com.jobpilot.pilot;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/**
 * One job moving through the Pilot pipeline. Mirrors the ai-job-search flow:
 * every stage's artifact is stored so the dashboard can show exactly what the
 * engine evaluated, drafted, reviewed, verified, and sent.
 *
 * Stages: scraped → evaluated → drafted → reviewed → revised → compiled →
 * verified → submitted | queued | skipped | failed.
 */
@Getter
@Setter
@Entity
@Table(name = "pilot_job")
public class PilotJob {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "cycle_id")
    private UUID cycleId;

    @Column(name = "user_id")
    private UUID userId;

    @Column(name = "job_id")
    private UUID jobId;

    @Column(name = "application_id")
    private UUID applicationId;

    // -- denormalised posting facts (survive the job purge) --
    @Column(name = "job_title")
    private String jobTitle;

    @Column(name = "job_company")
    private String jobCompany;

    @Column(name = "job_location")
    private String jobLocation;

    @Column(name = "job_url")
    private String jobUrl;

    @Column(name = "job_apply_type")
    private String jobApplyType;

    @Column(name = "job_apply_email")
    private String jobApplyEmail;

    /** Ingest quick score — the scrape-stage high/medium/low signal. */
    @Column(name = "match_score")
    private Integer matchScore;

    // -- pipeline state --
    @Column(nullable = false)
    private String stage = "scraped";

    /** JSON array of {stage, at, note} — the visible timeline. */
    @Column(name = "stage_log", columnDefinition = "text")
    private String stageLog;

    @Column(name = "skip_reason", columnDefinition = "text")
    private String skipReason;

    @Column(columnDefinition = "text")
    private String error;

    // -- stage artifacts --
    /** JSON: 6-dimension scores + weighted total + verdict + keywords. */
    @Column(columnDefinition = "text")
    private String evaluation;

    @Column(name = "fit_score")
    private Integer fitScore;

    /** strong | good | moderate | weak | poor */
    private String verdict;

    @Column(name = "cv_latex", columnDefinition = "text")
    private String cvLatex;

    @Column(name = "cover_letter", columnDefinition = "text")
    private String coverLetter;

    @Column(name = "reviewer_feedback", columnDefinition = "text")
    private String reviewerFeedback;

    @Column(name = "revision_notes", columnDefinition = "text")
    private String revisionNotes;

    /** JSON: contact/garbage checks + keyword coverage table. */
    @Column(name = "ats_report", columnDefinition = "text")
    private String atsReport;

    @Column(name = "tailoring_summary", columnDefinition = "text")
    private String tailoringSummary;

    @Column(name = "cv_pdf")
    private byte[] cvPdf;

    @Column(name = "cover_pdf")
    private byte[] coverPdf;

    /** queued items only: pending | opened | applied | dismissed */
    @Column(name = "queue_status")
    private String queueStatus;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
