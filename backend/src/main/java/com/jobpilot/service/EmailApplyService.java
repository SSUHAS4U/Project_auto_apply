package com.jobpilot.service;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.Application;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.repository.ApplicationRepository;
import com.jobpilot.repository.JobRepository;
import com.jobpilot.service.cover.CoverLetterService;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/**
 * Feature #6 — the only fully-automated submission path. Sends resume + tailored
 * cover letter from the owner's own mailbox. Rate-limited and owner-confirmed.
 */
@Service
public class EmailApplyService {

    private final JobRepository jobRepo;
    private final ApplicationRepository appRepo;
    private final ProfileService profileService;
    private final CoverLetterService coverLetters;
    private final MailService mail;
    private final ApplicationService applications;
    private final JobPilotProperties props;

    public EmailApplyService(JobRepository jobRepo,
                             ApplicationRepository appRepo,
                             ProfileService profileService,
                             CoverLetterService coverLetters,
                             MailService mail,
                             ApplicationService applications,
                             JobPilotProperties props) {
        this.jobRepo = jobRepo;
        this.appRepo = appRepo;
        this.profileService = profileService;
        this.coverLetters = coverLetters;
        this.mail = mail;
        this.applications = applications;
        this.props = props;
    }

    public String previewCoverLetter(UUID jobId) {
        Job job = job(jobId);
        Profile profile = profileService.get();
        return coverLetters.generate(job, profile);
    }

    public ApplyResult apply(UUID jobId, String coverLetterOverride) {
        Job job = job(jobId);
        Profile profile = profileService.get();

        if (!"email".equalsIgnoreCase(job.getApplyType()) || isBlank(job.getApplyEmail())) {
            throw new IllegalArgumentException("job is not an email-apply job (apply_type="
                    + job.getApplyType() + ")");
        }
        enforceDailyLimit();
        byte[] resumeBytes = profile.getResumeData();
        if (resumeBytes == null || resumeBytes.length == 0) {
            throw new IllegalStateException("no resume on file — upload one in Profile before applying");
        }

        String letter = (coverLetterOverride != null && !coverLetterOverride.isBlank())
                ? coverLetterOverride
                : coverLetters.generate(job, profile);

        String subject = "Application: " + job.getTitle() + " — " + profile.getFullName();
        String body = buildBody(profile, letter);
        String attachName = profile.getResumeFilename() == null ? "resume.pdf" : profile.getResumeFilename();

        mail.sendWithAttachmentBytes(job.getApplyEmail(), subject, body, resumeBytes, attachName);

        Application app = applications.markEmailApplied(job.getId(), letter);
        return new ApplyResult(app.getId(), job.getApplyEmail(), subject);
    }

    private void enforceDailyLimit() {
        int limit = props.getMail().getDailyLimit();
        Instant since = Instant.now().minus(1, ChronoUnit.DAYS);
        long sentToday = appRepo.countByUserIdAndMethodAndAppliedAtAfter(
                com.jobpilot.security.UserContext.require(), "email", since);
        if (sentToday >= limit) {
            throw new IllegalStateException("daily email-apply limit reached (" + limit + ")");
        }
    }

    private String buildBody(Profile profile, String letter) {
        StringBuilder sb = new StringBuilder();
        sb.append("Hello,\n\n");
        sb.append("Please find my application below, with my resume attached.\n\n");
        sb.append(letter).append("\n\n");
        sb.append(profile.getFullName());
        if (!isBlank(profile.getEmail())) sb.append("\n").append(profile.getEmail());
        if (!isBlank(profile.getPhone())) sb.append("\n").append(profile.getPhone());
        if (profile.getLinks() != null) {
            profile.getLinks().forEach((k, v) -> {
                if (v != null && !v.isBlank()) sb.append("\n").append(k).append(": ").append(v);
            });
        }
        return sb.toString();
    }

    private Job job(UUID id) {
        return jobRepo.findById(id).orElseThrow(() -> new NotFoundException("job not found: " + id));
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    public record ApplyResult(UUID applicationId, String sentTo, String subject) {}
}
