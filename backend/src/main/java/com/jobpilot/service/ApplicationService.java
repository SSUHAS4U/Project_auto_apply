package com.jobpilot.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.domain.Application;
import com.jobpilot.domain.ApplicationEvent;
import com.jobpilot.domain.Job;
import com.jobpilot.repository.ApplicationEventRepository;
import com.jobpilot.repository.ApplicationRepository;
import com.jobpilot.repository.JobRepository;
import com.jobpilot.security.UserContext;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Service
public class ApplicationService {

    public static final Set<String> STATUSES = Set.of(
            "interested", "applied", "interviewing", "offer", "rejected", "withdrawn");

    private final ApplicationRepository appRepo;
    private final ApplicationEventRepository eventRepo;
    private final JobRepository jobRepo;
    private final ObjectMapper mapper = new ObjectMapper();

    public ApplicationService(ApplicationRepository appRepo,
                              ApplicationEventRepository eventRepo,
                              JobRepository jobRepo) {
        this.appRepo = appRepo;
        this.eventRepo = eventRepo;
        this.jobRepo = jobRepo;
    }

    public List<Application> list(String status) {
        UUID userId = UserContext.require();
        return (status == null || status.isBlank())
                ? appRepo.findByUserIdOrderByUpdatedAtDesc(userId)
                : appRepo.findByUserIdAndStatusOrderByUpdatedAtDesc(userId, status);
    }

    /** Applications enriched with their linked job summary, for the dashboard. */
    public List<com.jobpilot.web.dto.ApplicationView> listDetailed(String status) {
        return list(status).stream().map(a -> {
            com.jobpilot.domain.Job job = a.getJobId() == null ? null
                    : jobRepo.findById(a.getJobId()).orElse(null);
            return com.jobpilot.web.dto.ApplicationView.of(a, job);
        }).toList();
    }

    public Application get(UUID id) {
        UUID userId = UserContext.require();
        return appRepo.findById(id)
                .filter(a -> userId.equals(a.getUserId()))
                .orElseThrow(() -> new NotFoundException("application not found: " + id));
    }

    /** Track a job: create (or return existing) application in 'interested'. */
    @Transactional
    public Application track(UUID jobId) {
        UUID userId = UserContext.require();
        Job job = jobRepo.findById(jobId).orElseThrow(() -> new NotFoundException("job not found: " + jobId));
        return appRepo.findFirstByUserIdAndJobId(userId, job.getId()).orElseGet(() -> {
            Application a = new Application();
            a.setUserId(userId);
            a.setJobId(job.getId());
            a.setStatus("interested");
            a.setMethod("manual");
            Application saved = appRepo.save(a);
            logEvent(saved.getId(), "status_change", Map.of("to", "interested"));
            return saved;
        });
    }

    /** Manual add (job may be null for off-platform applications). */
    @Transactional
    public Application create(UUID jobId, String status, String notes) {
        Application a = new Application();
        a.setUserId(UserContext.require());
        a.setJobId(jobId);
        a.setStatus(validStatus(status, "interested"));
        a.setMethod("manual");
        a.setNotes(notes);
        if ("applied".equals(a.getStatus())) a.setAppliedAt(Instant.now());
        Application saved = appRepo.save(a);
        logEvent(saved.getId(), "status_change", Map.of("to", saved.getStatus()));
        return saved;
    }

    @Transactional
    public Application update(UUID id, String status, String notes) {
        Application a = get(id);
        if (status != null && !status.isBlank()) {
            String newStatus = validStatus(status, a.getStatus());
            if (!newStatus.equals(a.getStatus())) {
                logEvent(a.getId(), "status_change", Map.of("from", a.getStatus(), "to", newStatus));
                a.setStatus(newStatus);
                if ("applied".equals(newStatus) && a.getAppliedAt() == null) {
                    a.setAppliedAt(Instant.now());
                }
            }
        }
        if (notes != null) {
            a.setNotes(notes);
            logEvent(a.getId(), "note", Map.of("notes", notes));
        }
        a.setUpdatedAt(Instant.now());
        return appRepo.save(a);
    }

    public List<ApplicationEvent> timeline(UUID id) {
        get(id); // 404 if missing
        return eventRepo.findByApplicationIdOrderByCreatedAtAsc(id);
    }

    /** Used by the email-apply engine to mark a tracked application sent. */
    @Transactional
    public Application markEmailApplied(UUID jobId, String coverLetter) {
        UUID userId = UserContext.require();
        Application a = appRepo.findFirstByUserIdAndJobId(userId, jobId).orElseGet(() -> {
            Application n = new Application();
            n.setUserId(userId);
            n.setJobId(jobId);
            return n;
        });
        a.setStatus("applied");
        a.setMethod("email");
        a.setCoverLetter(coverLetter);
        a.setAppliedAt(Instant.now());
        a.setUpdatedAt(Instant.now());
        Application saved = appRepo.save(a);
        logEvent(saved.getId(), "email_sent", Map.of("at", Instant.now().toString()));
        return saved;
    }

    public void logEvent(UUID applicationId, String type, Map<String, Object> detail) {
        ApplicationEvent e = new ApplicationEvent();
        e.setApplicationId(applicationId);
        e.setEventType(type);
        try {
            e.setDetail(mapper.writeValueAsString(detail));
        } catch (Exception ex) {
            e.setDetail("{}");
        }
        eventRepo.save(e);
    }

    private String validStatus(String s, String fallback) {
        if (s == null) return fallback;
        String v = s.trim().toLowerCase();
        if (!STATUSES.contains(v)) {
            throw new IllegalArgumentException("invalid status '" + s + "'. allowed: " + STATUSES);
        }
        return v;
    }
}
