package com.jobpilot.web;

import com.jobpilot.domain.Profile;
import com.jobpilot.domain.SavedJob;
import com.jobpilot.service.ProfileService;
import com.jobpilot.service.SavedJobService;
import com.jobpilot.web.dto.SavedJobRequest;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/extension")
public class ExtensionController {

    private final SavedJobService savedJobs;
    private final ProfileService profile;

    public ExtensionController(SavedJobService savedJobs, ProfileService profile) {
        this.savedJobs = savedJobs;
        this.profile = profile;
    }

    /** Extension pushes a captured listing from LinkedIn/Naukri/Indeed/etc. */
    @PostMapping("/saved-job")
    public SavedJob savedJob(@RequestBody SavedJobRequest req) {
        return savedJobs.capture(req.title(), req.company(), req.location(),
                req.url(), req.sourceSite(), req.raw());
    }

    /** Extension pulls profile + field_map for autofill. */
    @GetMapping("/profile-export")
    public Map<String, Object> profileExport() {
        Profile p = profile.get();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("full_name", p.getFullName());
        out.put("email", p.getEmail());
        out.put("phone", p.getPhone());
        out.put("location", p.getLocation());
        out.put("links", p.getLinks());
        out.put("skills", p.getSkills());
        out.put("seniority", p.getSeniority());
        out.put("field_map", p.getFieldMap());
        return out;
    }
}
