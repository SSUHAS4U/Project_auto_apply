package com.jobpilot.web;

import com.jobpilot.service.DigestService;
import com.jobpilot.service.IngestService;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** Cron-only operational endpoints (token protected like the rest of /api). */
@RestController
@RequestMapping("/api")
public class OpsController {

    private final IngestService ingest;
    private final DigestService digest;

    public OpsController(IngestService ingest, DigestService digest) {
        this.ingest = ingest;
        this.digest = digest;
    }

    @PostMapping("/ingest")
    public IngestService.IngestResult ingest() {
        return ingest.run();
    }

    @PostMapping("/digest")
    public Map<String, Object> digest() {
        return digest.run();
    }
}
