package com.jobpilot.web;

import com.jobpilot.domain.Profile;
import com.jobpilot.service.ProfileService;
import com.jobpilot.service.ResumeStorageService;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

@RestController
@RequestMapping("/api/profile")
public class ProfileController {

    private final ProfileService service;
    private final ResumeStorageService resume;

    public ProfileController(ProfileService service, ResumeStorageService resume) {
        this.service = service;
        this.resume = resume;
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
        ResumeStorageService.Stored stored = resume.store(file);
        service.setResume(stored.path(), stored.filename());
        return Map.of("filename", stored.filename(), "stored", true);
    }
}
