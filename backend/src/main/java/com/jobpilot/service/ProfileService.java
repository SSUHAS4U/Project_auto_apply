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
    public Profile save(Profile in) {
        Profile p = repo.findFirstByOrderByUpdatedAtAsc().orElseGet(Profile::new);
        // Personal
        p.setFullName(in.getFullName());
        p.setFirstName(in.getFirstName());
        p.setLastName(in.getLastName());
        p.setEmail(in.getEmail());
        p.setPhone(in.getPhone());
        p.setHeadline(in.getHeadline());
        p.setSummary(in.getSummary());
        p.setLocation(in.getLocation());
        p.setLocation2(in.getLocation2());
        p.setAddress(in.getAddress());
        p.setCity(in.getCity());
        p.setState(in.getState());
        p.setCountry(in.getCountry());
        p.setPostalCode(in.getPostalCode());
        p.setDateOfBirth(in.getDateOfBirth());
        p.setGender(in.getGender());
        p.setNationality(in.getNationality());
        // Professional
        p.setSeniority(in.getSeniority());
        p.setCurrentTitle(in.getCurrentTitle());
        p.setCurrentCompany(in.getCurrentCompany());
        p.setYearsExperience(in.getYearsExperience());
        p.setCurrentCtc(in.getCurrentCtc());
        p.setExpectedCtc(in.getExpectedCtc());
        p.setNoticePeriod(in.getNoticePeriod());
        p.setAvailableFrom(in.getAvailableFrom());
        p.setWorkAuthorization(in.getWorkAuthorization());
        p.setRequiresSponsorship(in.getRequiresSponsorship());
        p.setWillingToRelocate(in.getWillingToRelocate());
        if (in.getPreferredLocations() != null) p.setPreferredLocations(in.getPreferredLocations());
        if (in.getLanguages() != null) p.setLanguages(in.getLanguages());
        if (in.getSkills() != null) p.setSkills(in.getSkills());
        // Structured
        if (in.getExperience() != null) p.setExperience(in.getExperience());
        if (in.getEducation() != null) p.setEducation(in.getEducation());
        if (in.getCertifications() != null) p.setCertifications(in.getCertifications());
        if (in.getLinks() != null) p.setLinks(in.getLinks());
        if (in.getFieldMap() != null) p.setFieldMap(in.getFieldMap());
        p.setCoverLetterTemplate(in.getCoverLetterTemplate());
        p.setEmailTemplate(in.getEmailTemplate());
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
