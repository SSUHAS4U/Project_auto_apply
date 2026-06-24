package com.jobpilot.web;

import com.jobpilot.service.ComposeService;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/compose")
public class ComposeController {

    private final ComposeService compose;

    public ComposeController(ComposeService compose) {
        this.compose = compose;
    }

    /** Generate cover letter + cold email from free-form job details. */
    @PostMapping("/generate")
    public Map<String, String> generate(@RequestBody Map<String, String> body) {
        return compose.generate(body.get("role"), body.get("company"), body.get("jobDetails"));
    }

    /** AI-refine the email and/or cover letter per a free-form instruction (composer chat). */
    @PostMapping("/refine")
    public Map<String, String> refine(@RequestBody Map<String, String> body) {
        return compose.refine(body.get("coldEmail"), body.get("coverLetter"), body.get("instruction"));
    }

    /** Render the cover letter to a PDF for download/preview. */
    @PostMapping("/cover-pdf")
    public org.springframework.http.ResponseEntity<byte[]> coverPdf(@RequestBody Map<String, String> body) {
        byte[] pdf = compose.coverPdf(body.get("coverLetter"));
        return org.springframework.http.ResponseEntity.ok()
                .header("Content-Type", "application/pdf")
                .header("Content-Disposition", "attachment; filename=\"CoverLetter.pdf\"")
                .body(pdf);
    }

    /** Send the composed email (cold email + cover letter + resume) to a recipient. */
    @PostMapping("/send")
    public Map<String, Object> send(@RequestBody Map<String, Object> body) {
        return compose.send(
                (String) body.get("to"),
                (String) body.get("subject"),
                (String) body.get("coldEmail"),
                (String) body.get("coverLetter"),
                Boolean.TRUE.equals(body.get("attachResume")));
    }
}
