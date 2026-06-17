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

    public record JobSummary(String title, String company, String location, String url,
                             String applyType, String applyEmail, Integer matchScore, boolean remote) {}

    public static ApplicationView of(Application a, Job job) {
        JobSummary js = job == null ? null : new JobSummary(
                job.getTitle(), job.getCompany(), job.getLocation(), job.getUrl(),
                job.getApplyType(), job.getApplyEmail(), job.getMatchScore(), job.isRemote());
        return new ApplicationView(a.getId(), a.getJobId(), a.getStatus(), a.getMethod(),
                a.getAppliedAt(), a.getCoverLetter(), a.getNotes(),
                a.getCreatedAt(), a.getUpdatedAt(), js);
    }
}
