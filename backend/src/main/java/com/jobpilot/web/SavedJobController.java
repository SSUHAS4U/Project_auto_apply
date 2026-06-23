package com.jobpilot.web;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.SavedJob;
import com.jobpilot.service.SavedJobService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

/** Dashboard view over extension-captured listings. */
@RestController
@RequestMapping("/api/saved-jobs")
public class SavedJobController {

    private final SavedJobService service;

    public SavedJobController(SavedJobService service) {
        this.service = service;
    }

    @GetMapping
    public List<SavedJob> list() {
        return service.list();
    }

    @PostMapping("/{id}/promote")
    public Job promote(@PathVariable UUID id) {
        return service.promote(id);
    }

    @DeleteMapping("/{id}")
    public java.util.Map<String, Object> delete(@PathVariable UUID id) {
        service.delete(id);
        return java.util.Map.of("deleted", true);
    }
}
