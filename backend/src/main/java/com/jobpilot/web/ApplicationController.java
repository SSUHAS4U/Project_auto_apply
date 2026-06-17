package com.jobpilot.web;

import com.jobpilot.domain.Application;
import com.jobpilot.domain.ApplicationEvent;
import com.jobpilot.service.ApplicationService;
import com.jobpilot.web.dto.CreateApplicationRequest;
import com.jobpilot.web.dto.UpdateApplicationRequest;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/applications")
public class ApplicationController {

    private final ApplicationService service;

    public ApplicationController(ApplicationService service) {
        this.service = service;
    }

    @GetMapping
    public List<com.jobpilot.web.dto.ApplicationView> list(@RequestParam(required = false) String status) {
        return service.listDetailed(status);
    }

    @PostMapping
    public Application create(@RequestBody CreateApplicationRequest req) {
        return service.create(req.jobId(), req.status(), req.notes());
    }

    @PatchMapping("/{id}")
    public Application update(@PathVariable UUID id, @RequestBody UpdateApplicationRequest req) {
        return service.update(id, req.status(), req.notes());
    }

    @GetMapping("/{id}/timeline")
    public List<ApplicationEvent> timeline(@PathVariable UUID id) {
        return service.timeline(id);
    }
}
