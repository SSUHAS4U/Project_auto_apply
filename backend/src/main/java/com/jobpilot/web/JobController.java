package com.jobpilot.web;

import com.jobpilot.domain.Application;
import com.jobpilot.domain.Job;
import com.jobpilot.service.ApplicationService;
import com.jobpilot.service.JobService;
import com.jobpilot.web.dto.PageResponse;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.UUID;

@RestController
@RequestMapping("/api/jobs")
public class JobController {

    private final JobService jobs;
    private final ApplicationService applications;

    public JobController(JobService jobs, ApplicationService applications) {
        this.jobs = jobs;
        this.applications = applications;
    }

    @GetMapping
    public PageResponse<Job> list(
            @RequestParam(required = false) String role,
            @RequestParam(required = false) String location,
            @RequestParam(required = false) Integer minScore,
            @RequestParam(required = false) String applyType,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant since,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "25") int size) {
        return PageResponse.of(
                jobs.search(role, location, minScore, applyType, since, page, size),
                j -> j);
    }

    @GetMapping("/{id}")
    public Job get(@PathVariable UUID id) {
        return jobs.get(id);
    }

    @PostMapping("/{id}/track")
    public Application track(@PathVariable UUID id) {
        return applications.track(id);
    }
}
