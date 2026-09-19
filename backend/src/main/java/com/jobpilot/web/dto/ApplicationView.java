package com.jobpilot.web.dto;

import com.jobpilot.domain.Application;
import com.jobpilot.domain.Job;

import java.time.Instant;
import java.util.UUID;

/** Application enriched with a summary of its linked job (if any). */
public record ApplicationView(
        UUID id, UUID jobId, String status, String method,
        Instant appliedAt, String coverLetter, String notes,
        Instant createdAt, Instant updatedAt, JobSummary job) {

    /**
     * The linked job, as the shared job card needs it.
     *
     * `description`, `source`, `salaryText` and `postedAt` were missing here while sitting
     * right there on the Job row. The tracker therefore could not use the same card as the
     * board — with no description there are no derived facts and no skill match, and with no
     * source the card cannot say where the listing came from. Four fields, already fetched,
     * simply not projected.
     */
    public record JobSummary(String title, String company, String location, String url,
                             String applyType, String applyEmail, Integer matchScore, boolean remote,
                             String description, String source, String salaryText, Instant postedAt) {}

    public static ApplicationView of(Application a, Job job) {
        JobSummary js = job == null ? null : new JobSummary(
                job.getTitle(), job.getCompany(), job.getLocation(), job.getUrl(),
                job.getApplyType(), job.getApplyEmail(), job.getMatchScore(), job.isRemote(),
                job.getDescription(), job.getSource(), job.getSalaryText(), job.getPostedAt());
        return new ApplicationView(a.getId(), a.getJobId(), a.getStatus(), a.getMethod(),
                a.getAppliedAt(), a.getCoverLetter(), a.getNotes(),
                a.getCreatedAt(), a.getUpdatedAt(), js);
    }
}
