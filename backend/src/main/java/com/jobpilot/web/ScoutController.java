package com.jobpilot.web;

import com.jobpilot.domain.ScoutedJob;
import com.jobpilot.service.JobScoutService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The automated job scout: /run fires a scout pass (cron/admin), /jobs lists the
 * current refined results for the dashboard's Scout section.
 */
@RestController
@RequestMapping("/api/scout")
public class ScoutController {

    private final JobScoutService scout;

    public ScoutController(JobScoutService scout) {
        this.scout = scout;
    }

    @PostMapping("/run")
    public Map<String, Object> run() {
        return scout.run();
    }

    @GetMapping("/jobs")
    public List<ScoutedJob> jobs(@RequestParam(defaultValue = "200") int limit) {
        return scout.latest(limit);
    }

    @DeleteMapping("/jobs/{id}")
    public Map<String, Object> delete(@PathVariable UUID id) {
        scout.delete(id);
        return Map.of("deleted", true);
    }
}
