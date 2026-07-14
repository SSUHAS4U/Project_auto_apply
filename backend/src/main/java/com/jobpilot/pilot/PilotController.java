package com.jobpilot.pilot;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The Pilot module's API. The dashboard is an OBSERVER of the pipeline —
 * read endpoints dominate; the only controls are pause/resume, run-now,
 * config, and queue confirmations.
 */
@RestController
@RequestMapping("/api/pilot")
public class PilotController {

    private final PilotOrchestrator pilot;

    public PilotController(PilotOrchestrator pilot) {
        this.pilot = pilot;
    }

    // ---- controls (the only writes the dashboard performs) ----

    @GetMapping("/status")
    public Map<String, Object> status() {
        return pilot.status();
    }

    /** The pause/resume switch. */
    @PostMapping("/toggle")
    public Map<String, Object> toggle(@RequestBody Map<String, Boolean> body) {
        boolean enabled = Boolean.TRUE.equals(body.get("enabled"));
        pilot.setEnabled(enabled);
        return Map.of("enabled", enabled);
    }

    @PutMapping("/config")
    public PilotOrchestrator.Config saveConfig(@RequestBody PilotOrchestrator.Config config) {
        return pilot.saveConfig(config);
    }

    @PostMapping("/run")
    public Map<String, Object> run() {
        if (!pilot.isEnabled()) {
            return Map.of("status", "paused", "message", "Pilot is paused — resume it first.");
        }
        return pilot.startAsync("manual");
    }

    // ---- observation ----

    @GetMapping("/cycles")
    public List<PilotCycle> cycles(@RequestParam(defaultValue = "20") int limit) {
        return pilot.cycleHistory(limit);
    }

    @GetMapping("/cycles/{id}/jobs")
    public List<PilotJobRepository.Summary> cycleJobs(@PathVariable UUID id) {
        return pilot.cycleJobs(id);
    }

    @GetMapping("/jobs")
    public List<PilotJobRepository.Summary> jobs(@RequestParam(required = false) String stage,
                                                 @RequestParam(defaultValue = "100") int limit) {
        return pilot.jobs(stage, limit);
    }

    /** Full artifact bundle for one job: evaluation, drafts, critique, ATS report, timeline. */
    @GetMapping("/jobs/{id}")
    public Map<String, Object> job(@PathVariable UUID id) {
        return pilot.jobDetail(id);
    }

    @GetMapping("/jobs/{id}/cv.pdf")
    public ResponseEntity<byte[]> cvPdf(@PathVariable UUID id) {
        return pdf(pilot.cvPdf(id), "cv.pdf");
    }

    @GetMapping("/jobs/{id}/cover.pdf")
    public ResponseEntity<byte[]> coverPdf(@PathVariable UUID id) {
        return pdf(pilot.coverPdf(id), "cover-letter.pdf");
    }

    // ---- extension queue ----

    @GetMapping("/queue")
    public List<PilotJobRepository.Summary> queue(@RequestParam(defaultValue = "100") int limit) {
        return pilot.queue(limit);
    }

    @PostMapping("/queue/{id}/status")
    public Map<String, Object> queueStatus(@PathVariable UUID id, @RequestBody Map<String, String> body) {
        return pilot.updateQueue(id, body.getOrDefault("status", ""));
    }

    private ResponseEntity<byte[]> pdf(byte[] bytes, String name) {
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header("Content-Disposition", "inline; filename=\"" + name + "\"")
                .body(bytes);
    }
}
