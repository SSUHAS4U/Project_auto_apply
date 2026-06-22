package com.jobpilot.web;

import com.jobpilot.domain.Profile;
import com.jobpilot.service.ProfileService;
import com.jobpilot.service.ResumeAnalysisService;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

@RestController
@RequestMapping("/api/profile")
public class ProfileController {

    private final ProfileService service;
    private final ResumeAnalysisService analysis;

    public ProfileController(ProfileService service, ResumeAnalysisService analysis) {
        this.service = service;
        this.analysis = analysis;
    }

    @GetMapping
    public Profile get() {
        return service.get();
    }

    @PutMapping
    public Profile update(@RequestBody Profile profile) {
        return service.save(profile);
    }

    @PostMapping("/resume")
    public Map<String, Object> uploadResume(@RequestParam("file") MultipartFile file) {
        if (file == null || file.isEmpty()) throw new IllegalArgumentException("resume file is empty");
        String name = file.getOriginalFilename() == null ? "resume.pdf" : file.getOriginalFilename();
        try {
            service.setResumeData(file.getBytes(), name); // store in DB so it persists across restarts
        } catch (java.io.IOException e) {
            throw new IllegalStateException("failed to read resume: " + e.getMessage(), e);
        }
        return Map.of("filename", name, "stored", true);
    }

    /** Upload + AI-parse a resume, auto-filling and saving the profile. */
    @PostMapping("/resume/analyze")
    public Profile analyzeResume(@RequestParam("file") MultipartFile file) {
        return analysis.analyzeAndFill(file);
    }
}
