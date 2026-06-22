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

    /** Extension pulls the resume bytes (base64) to attach to application file inputs. */
    @GetMapping("/resume")
    public Map<String, Object> resume() {
        Profile p = profile.get();
        byte[] data = p.getResumeData();
        if (data == null || data.length == 0) return Map.of("hasResume", false);
        return Map.of("hasResume", true,
                "filename", p.getResumeFilename() == null ? "resume.pdf" : p.getResumeFilename(),
                "contentBase64", java.util.Base64.getEncoder().encodeToString(data));
    }

    /** Extension pulls profile + a flattened answer map for autofill. */
    @GetMapping("/profile-export")
    public Map<String, Object> profileExport() {
        Profile p = profile.get();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("full_name", p.getFullName());
        out.put("first_name", p.getFirstName());
        out.put("last_name", p.getLastName());
        out.put("email", p.getEmail());
        out.put("phone", p.getPhone());
        out.put("headline", p.getHeadline());
        out.put("summary", p.getSummary());
        out.put("location", p.getLocation());
        out.put("address", p.getAddress());
        out.put("city", p.getCity());
        out.put("state", p.getState());
        out.put("country", p.getCountry());
        out.put("postal_code", p.getPostalCode());
        out.put("links", p.getLinks());
        out.put("skills", p.getSkills());
        out.put("seniority", p.getSeniority());
        out.put("college", p.getCollege());
        out.put("current_title", p.getCurrentTitle());
        out.put("current_company", p.getCurrentCompany());
        out.put("years_experience", p.getYearsExperience());
        out.put("current_ctc", p.getCurrentCtc());
        out.put("expected_ctc", p.getExpectedCtc());
        out.put("notice_period", p.getNoticePeriod());
        out.put("available_from", p.getAvailableFrom());
        out.put("work_authorization", p.getWorkAuthorization());
        out.put("requires_sponsorship", p.getRequiresSponsorship());
        out.put("willing_to_relocate", p.getWillingToRelocate());
        out.put("field_map", p.getFieldMap());
        return out;
    }
}
