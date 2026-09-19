package com.jobpilot.service.jobs;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.domain.SavedJob;
import com.jobpilot.repository.JobRepository;
import com.jobpilot.repository.ProfileRepository;
import com.jobpilot.repository.SavedJobRepository;
import com.jobpilot.security.UserContext;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.util.HtmlUtils;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import com.jobpilot.service.NotFoundException;

/** Capture + promote listings pushed by the extension (Feature #2). */
@Service
public class SavedJobService {

    private final SavedJobRepository savedRepo;
    private final JobRepository jobRepo;
    private final NormalizeService normalize;
    private final ApplicationService applications;
    private final ProfileRepository profileRepo;
    private final MatchScorer scorer;

    public SavedJobService(SavedJobRepository savedRepo, JobRepository jobRepo,
                           NormalizeService normalize, ApplicationService applications,
                           ProfileRepository profileRepo, MatchScorer scorer) {
        this.savedRepo = savedRepo;
        this.jobRepo = jobRepo;
        this.normalize = normalize;
        this.applications = applications;
        this.profileRepo = profileRepo;
        this.scorer = scorer;
    }

    public List<SavedJob> list() {
        return savedRepo.findByUserIdOrderByCreatedAtDesc(UserContext.require());
    }

    /** Delete a saved listing (only the owner's own). */
    @Transactional
    public void delete(UUID id) {
        UUID userId = UserContext.require();
        savedRepo.findById(id).filter(s -> userId.equals(s.getUserId())).ifPresent(savedRepo::delete);
    }

    /** Edit a saved listing's details (only the owner's own). */
    @Transactional
    public SavedJob update(UUID id, String title, String company, String location, String url) {
        UUID userId = UserContext.require();
        SavedJob s = savedRepo.findById(id).filter(x -> userId.equals(x.getUserId()))
                .orElseThrow(() -> new IllegalArgumentException("saved job not found"));
        if (title != null) s.setTitle(clean(title));
        if (company != null) s.setCompany(clean(company));
        if (location != null) s.setLocation(clean(location));
        if (url != null && !url.isBlank()) s.setUrl(url.trim());
        return savedRepo.save(s);
    }

    /**
     * Persist a DOM-extracted listing. All text fields are escaped first.
     *
     * The description is what lets the Saved page use the SAME card as the job board: the
     * card derives employment type, experience and the matched/missing skill split from the
     * posting text. Without it there is nothing to derive and nothing to score, which is why
     * saved listings needed a card of their own for so long.
     */
    @Transactional
    public SavedJob capture(String title, String company, String location,
                            String url, String sourceSite, String raw, String description) {
        if (url == null || url.isBlank()) {
            throw new IllegalArgumentException("url is required");
        }
        SavedJob s = new SavedJob();
        s.setUserId(UserContext.require());
        s.setTitle(clean(title));
        s.setCompany(clean(company));
        s.setLocation(clean(location));
        s.setUrl(url.trim());
        s.setSourceSite(clean(sourceSite));
        s.setRaw(raw); // stored as jsonb passthrough
        // Bounded before it is stored, not after: the extension sends whatever the page had,
        // and a listing page can carry a great deal of text.
        s.setDescription(description == null || description.isBlank() ? null
                : clean(description.length() > MAX_DESCRIPTION ? description.substring(0, MAX_DESCRIPTION) : description));
        s.setMatchScore(scoreOf(s));
        return savedRepo.save(s);
    }

    /** Longest posting text we keep — comfortably more than any card needs to derive facts. */
    private static final int MAX_DESCRIPTION = 20_000;

    /**
     * Score a saved listing exactly as the board scores its own, so the fit panel means the
     * same thing on both. Null when there is nothing to score against — a saved job with no
     * description, or a profile with no skills, gets no fit panel rather than a fake zero.
     */
    private Integer scoreOf(SavedJob s) {
        if (s.getDescription() == null) return null;
        Profile profile = profileRepo.findByUserId(UserContext.require()).orElse(null);
        if (profile == null || profile.getSkills() == null || profile.getSkills().isEmpty()) return null;
        Job probe = new Job();
        probe.setTitle(s.getTitle());
        probe.setCompany(s.getCompany());
        probe.setLocation(s.getLocation());
        probe.setDescription(s.getDescription());
        return scorer.score(probe, profile);
    }

    /** Turn a saved listing into a real job + tracked application. */
    @Transactional
    public Job promote(UUID savedId) {
        UUID userId = UserContext.require();
        SavedJob s = savedRepo.findById(savedId)
                .filter(x -> userId.equals(x.getUserId()))
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
            // Carry the posting across. A promoted listing becomes a tracked application, and
            // the tracker renders the same card as the board — without these it would arrive
            // there stripped of exactly the fields that card reads.
            j.setDescription(s.getDescription());
            j.setMatchScore(s.getMatchScore());
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
