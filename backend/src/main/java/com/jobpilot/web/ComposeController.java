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
