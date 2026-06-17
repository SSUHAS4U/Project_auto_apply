package com.jobpilot.service;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.SavedJob;
import com.jobpilot.repository.JobRepository;
import com.jobpilot.repository.SavedJobRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.util.HtmlUtils;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Capture + promote listings pushed by the extension (Feature #2). */
@Service
public class SavedJobService {

    private final SavedJobRepository savedRepo;
    private final JobRepository jobRepo;
    private final NormalizeService normalize;
    private final ApplicationService applications;

    public SavedJobService(SavedJobRepository savedRepo, JobRepository jobRepo,
                           NormalizeService normalize, ApplicationService applications) {
        this.savedRepo = savedRepo;
        this.jobRepo = jobRepo;
        this.normalize = normalize;
        this.applications = applications;
    }

    public List<SavedJob> list() {
        return savedRepo.findAllByOrderByCreatedAtDesc();
    }

    /** Persist a DOM-extracted listing. All text fields are escaped first. */
    @Transactional
    public SavedJob capture(String title, String company, String location,
                            String url, String sourceSite, String raw) {
        if (url == null || url.isBlank()) {
            throw new IllegalArgumentException("url is required");
        }
        SavedJob s = new SavedJob();
        s.setTitle(clean(title));
        s.setCompany(clean(company));
        s.setLocation(clean(location));
        s.setUrl(url.trim());
        s.setSourceSite(clean(sourceSite));
        s.setRaw(raw); // stored as jsonb passthrough
        return savedRepo.save(s);
    }

    /** Turn a saved listing into a real job + tracked application. */
    @Transactional
    public Job promote(UUID savedId) {
        SavedJob s = savedRepo.findById(savedId)
                .orElseThrow(() -> new NotFoundException("saved job not found: " + savedId));
        String hash = normalize.contentHash(s.getCompany(), s.getTitle(), s.getLocation());
        Job job = jobRepo.findByContentHash(hash).orElseGet(() -> {
            Job j = new Job();
            j.setSource("extension:" + (s.getSourceSite() == null ? "saved" : s.getSourceSite()));
            j.setTitle(s.getTitle() == null ? "Saved job" : s.getTitle());
            j.setCompany(s.getCompany());
            j.setLocation(s.getLocation());
            j.setUrl(s.getUrl());
            j.setApplyType("url");
            j.setContentHash(hash);
            j.setFetchedAt(Instant.now());
            j.setRaw(s.getRaw());
            return jobRepo.save(j);
        });
        s.setPromotedJobId(job.getId());
        savedRepo.save(s);
        applications.track(job.getId());
        return job;
    }

    private String clean(String s) {
        return s == null ? null : HtmlUtils.htmlEscape(s.trim());
    }
}
