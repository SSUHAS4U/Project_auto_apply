package com.jobpilot.web;

import com.jobpilot.domain.QaPair;
import com.jobpilot.service.AssistService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Assisted-apply endpoints for the extension (JWT-authenticated, per user):
 * answer free-text questions with AI, manage the saved Q&A bank, and generate
 * cover letters on demand.
 */
@RestController
@RequestMapping("/api/assist")
public class AssistController {

    private final AssistService assist;

    public AssistController(AssistService assist) {
        this.assist = assist;
    }

    @PostMapping("/answer")
    public Map<String, Object> answer(@RequestBody Map<String, String> body) {
        return assist.answer(body.get("question"));
    }

    @GetMapping("/qa")
    public List<QaPair> listQa() {
        return assist.listQa();
    }

    @PostMapping("/qa")
    public QaPair saveQa(@RequestBody Map<String, String> body) {
        return assist.saveQa(body.get("question"), body.get("answer"));
    }

    @DeleteMapping("/qa/{id}")
    public Map<String, Object> deleteQa(@PathVariable UUID id) {
        assist.deleteQa(id);
        return Map.of("deleted", true);
    }

    @PostMapping("/cover-letter")
    public Map<String, Object> coverLetter(@RequestBody Map<String, String> body) {
        String text = assist.coverLetter(body.get("company"), body.get("role"), body.get("jobText"));
        return Map.of("text", text);
    }
}
