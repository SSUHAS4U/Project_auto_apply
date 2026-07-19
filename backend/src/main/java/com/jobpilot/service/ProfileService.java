package com.jobpilot.service;

import com.jobpilot.domain.Profile;
import com.jobpilot.repository.ProfileRepository;
import com.jobpilot.security.UserContext;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.UUID;

@Service
public class ProfileService {

    private final ProfileRepository repo;

    public ProfileService(ProfileRepository repo) {
        this.repo = repo;
    }

    /** The current (logged-in) user's profile; created blank if missing. */
    @Transactional
    public Profile get() {
        UUID userId = UserContext.require();
        return repo.findByUserId(userId).orElseGet(() -> {
            Profile p = new Profile();
            p.setUserId(userId);
            p.setFullName("Your Name");
            p.setEmail("");
            p.setUpdatedAt(Instant.now());
            return repo.save(p);
        });
    }

    /** The owner/first profile — for cron/ingest contexts that have no logged-in user. */
    @Transactional(readOnly = true)
    public Profile getOwner() {
        return repo.findFirstByOrderByUpdatedAtAsc()
                .orElseThrow(() -> new NotFoundException("no profile yet — register an account first"));
    }

    @Transactional
    public Profile save(Profile in) {
        Profile p = get();
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
        p.setAddress2(in.getAddress2());
        p.setCity2(in.getCity2());
        p.setState2(in.getState2());
        p.setCountry2(in.getCountry2());
        p.setPostalCode2(in.getPostalCode2());
        p.setDateOfBirth(in.getDateOfBirth());
        p.setGender(in.getGender());
        p.setNationality(in.getNationality());
        p.setAlternatePhone(in.getAlternatePhone());
        p.setMaritalStatus(in.getMaritalStatus());
        p.setFatherName(in.getFatherName());
        p.setDisabilityStatus(in.getDisabilityStatus());
        p.setOpenToShifts(in.getOpenToShifts());
        p.setLeetcodeUrl(in.getLeetcodeUrl());
        p.setLeetcodeScore(in.getLeetcodeScore());
        p.setCodechefUrl(in.getCodechefUrl());
        p.setCodechefScore(in.getCodechefScore());
        p.setCodeforcesUrl(in.getCodeforcesUrl());
        p.setCodeforcesScore(in.getCodeforcesScore());
        p.setLaptopConfig(in.getLaptopConfig());
        // Job profile
        p.setDesiredTitles(in.getDesiredTitles());
        p.setExperienceLevel(in.getExperienceLevel());
        p.setJobType(in.getJobType());
        if (in.getProjects() != null) p.setProjects(in.getProjects());
        if (in.getAchievements() != null) p.setAchievements(in.getAchievements());
        // Professional
        p.setSeniority(in.getSeniority());
        p.setCurrentTitle(in.getCurrentTitle());
        p.setCurrentCompany(in.getCurrentCompany());
        p.setYearsExperience(in.getYearsExperience());
        p.setCollege(in.getCollege());
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

    /** Persist the resume bytes in the DB (survives restarts) + its filename. */
    @Transactional
    public void setResumeData(byte[] data, String filename) {
        Profile p = get();
        p.setResumeData(data);
        p.setResumeFilename(filename);
        p.setResumePath("db"); // marker; real bytes live in resume_data
        p.setUpdatedAt(Instant.now());
        repo.save(p);
    }
}
