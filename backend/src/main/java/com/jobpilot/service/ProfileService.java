package com.jobpilot.service;

import com.jobpilot.domain.Profile;
import com.jobpilot.repository.ProfileRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

@Service
public class ProfileService {

    private final ProfileRepository repo;

    public ProfileService(ProfileRepository repo) {
        this.repo = repo;
    }

    /** The single owner profile (seeded by V1). Falls back to a blank one. */
    @Transactional(readOnly = true)
    public Profile get() {
        return repo.findFirstByOrderByUpdatedAtAsc()
                .orElseThrow(() -> new NotFoundException("profile not initialized"));
    }

    @Transactional
    public Profile save(Profile incoming) {
        Profile p = repo.findFirstByOrderByUpdatedAtAsc().orElseGet(Profile::new);
        p.setFullName(incoming.getFullName());
        p.setEmail(incoming.getEmail());
        p.setPhone(incoming.getPhone());
        p.setLocation(incoming.getLocation());
        if (incoming.getLinks() != null) p.setLinks(incoming.getLinks());
        if (incoming.getSkills() != null) p.setSkills(incoming.getSkills());
        p.setSeniority(incoming.getSeniority());
        if (incoming.getExperience() != null) p.setExperience(incoming.getExperience());
        if (incoming.getFieldMap() != null) p.setFieldMap(incoming.getFieldMap());
        p.setUpdatedAt(Instant.now());
        return repo.save(p);
    }

    @Transactional
    public void setResume(String path, String filename) {
        Profile p = get();
        p.setResumePath(path);
        p.setResumeFilename(filename);
        p.setUpdatedAt(Instant.now());
        repo.save(p);
    }
}
