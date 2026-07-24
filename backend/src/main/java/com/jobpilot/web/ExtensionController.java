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
    private final com.jobpilot.service.ResumeDocService resumeDocs;
    private final com.jobpilot.pilot.PilotOrchestrator pilot;

    public ExtensionController(SavedJobService savedJobs, ProfileService profile,
                               com.jobpilot.service.ResumeDocService resumeDocs,
                               com.jobpilot.pilot.PilotOrchestrator pilot) {
        this.savedJobs = savedJobs;
        this.profile = profile;
        this.resumeDocs = resumeDocs;
        this.pilot = pilot;
    }

    /** Pilot queue for the extension: portal jobs with tailored documents ready to fill. */
    @GetMapping("/auto-apply/queue")
    public java.util.List<Map<String, Object>> autoApplyQueue(@RequestParam(defaultValue = "50") int limit) {
        return pilot.queue(limit).stream().<Map<String, Object>>map(i -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", i.getId().toString());
            m.put("title", i.getJobTitle());
            m.put("company", i.getJobCompany());
            m.put("url", i.getJobUrl());
            m.put("matchScore", i.getFitScore() != null ? i.getFitScore() : i.getMatchScore());
            m.put("reason", i.getVerdict() == null ? i.getSkipReason()
                    : i.getVerdict() + " fit " + i.getFitScore() + "/100 — tailored CV + letter ready");
            return m;
        }).toList();
    }

    /** Extension reports what happened to a queue item: opened | applied | dismissed. */
    @PostMapping("/auto-apply/queue/{id}/status")
    public Map<String, Object> autoApplyQueueStatus(@PathVariable java.util.UUID id,
                                                    @RequestBody Map<String, String> body) {
        return pilot.updateQueue(id, body.getOrDefault("status", ""));
    }

    /** Extension pushes a captured listing from LinkedIn/Naukri/Indeed/etc. */
    @PostMapping("/saved-job")
    public SavedJob savedJob(@RequestBody SavedJobRequest req) {
        return savedJobs.capture(req.title(), req.company(), req.location(),
                req.url(), req.sourceSite(), req.raw());
    }

    /**
     * Extension pulls resume bytes (base64) to attach to application file inputs.
     * No {@code docId} → the profile's uploaded resume; with {@code docId} → the
     * compiled PDF of that LaTeX resume doc (the "which resume?" picker).
     */
    @GetMapping("/resume")
    public Map<String, Object> resume(@RequestParam(required = false) java.util.UUID docId) {
        if (docId != null) {
            com.jobpilot.domain.ResumeDoc d = resumeDocs.get(docId);
            byte[] pdf = resumeDocs.pdf(docId);
            return Map.of("hasResume", true,
                    "filename", d.getName().replaceAll("[^A-Za-z0-9 _-]", "").trim() + ".pdf",
                    "contentBase64", java.util.Base64.getEncoder().encodeToString(pdf));
        }
        Profile p = profile.get();
        byte[] data = p.getResumeData();
        if (data == null || data.length == 0) return Map.of("hasResume", false);
        return Map.of("hasResume", true,
                "filename", p.getResumeFilename() == null ? "resume.pdf" : p.getResumeFilename(),
                "contentBase64", java.util.Base64.getEncoder().encodeToString(data));
    }

    /** Resume picker options for the extension: profile resume + compiled LaTeX resumes. */
    @GetMapping("/resumes")
    public java.util.List<Map<String, Object>> resumeOptions() {
        java.util.List<Map<String, Object>> out = new java.util.ArrayList<>();
        Profile p = profile.get();
        if (p.getResumeData() != null && p.getResumeData().length > 0) {
            out.add(Map.of("id", "", "name",
                    "Profile resume (" + (p.getResumeFilename() == null ? "resume.pdf" : p.getResumeFilename()) + ")",
                    "hasPdf", true, "base", false));
        }
        for (com.jobpilot.domain.ResumeDoc d : resumeDocs.list()) {
            out.add(Map.of("id", d.getId().toString(), "name", d.getName(),
                    "hasPdf", d.isHasPdf(), "base", d.isBase()));
        }
        return out;
    }

    /** Extension pulls profile + a flattened answer map for autofill. */
    @GetMapping("/profile-export")
    public Map<String, Object> profileExport() {
        Profile p = profile.get();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("full_name", p.getFullName());
        // Derived when the user hasn't set them — most forms want the name in three boxes.
        com.jobpilot.service.NameParts np = com.jobpilot.service.NameParts.of(p);
        out.put("first_name", np.first());
        out.put("middle_name", np.middle());
        out.put("last_name", np.last());
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
