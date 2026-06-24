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

    @PutMapping("/{id}")
    public SavedJob update(@PathVariable UUID id, @RequestBody java.util.Map<String, String> body) {
        return service.update(id, body.get("title"), body.get("company"), body.get("location"), body.get("url"));
    }

    @DeleteMapping("/{id}")
    public java.util.Map<String, Object> delete(@PathVariable UUID id) {
        service.delete(id);
        return java.util.Map.of("deleted", true);
    }
}
