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
        return assist.answer(body.get("question"), body.get("fieldType"));
    }

    /** Name fields the DOM couldn't label: {fields:[{key,context}]} → {labels:{key:label}}. */
    @PostMapping("/labels")
    @SuppressWarnings("unchecked")
    public Map<String, Object> labels(@RequestBody Map<String, Object> body) {
        Object fields = body.get("fields");
        return Map.of("labels", assist.labels(fields instanceof java.util.List<?> l
                ? (java.util.List<Map<String, String>>) l : java.util.List.of()));
    }

    @PostMapping("/choose")
    @SuppressWarnings("unchecked")
    public Map<String, Object> choose(@RequestBody Map<String, Object> body) {
        String question = (String) body.get("question");
        List<String> options = (List<String>) body.get("options");
        boolean multi = Boolean.TRUE.equals(body.get("multi"));
        return assist.choose(question, options, multi);
    }

    @PostMapping("/autofill")
    @SuppressWarnings("unchecked")
    public Map<String, Object> autofill(@RequestBody Map<String, Object> body) {
        List<String> fields = (List<String>) body.get("fields");
        return Map.of("answers", assist.autofill(fields));
    }

    /**
     * Answer a whole form in one semantic pass — every question, its control type and its real
     * options go up together, so the model reads the form the way a person does instead of
     * being asked about each field in isolation.
     */
    @PostMapping("/fill-form")
    @SuppressWarnings("unchecked")
    public Map<String, Object> fillForm(@RequestBody Map<String, Object> body) {
        List<Map<String, Object>> fields = (List<Map<String, Object>>) body.get("fields");
        return assist.fillForm(fields);
    }

    @PostMapping("/scan-job")
    public Map<String, String> scanJob(@RequestBody Map<String, String> body) {
        return assist.scanJob(body.get("text"), body.get("title"), body.get("url"));
    }

    @PostMapping("/command")
    @SuppressWarnings("unchecked")
    public Map<String, Object> command(@RequestBody Map<String, Object> body) {
        String instruction = (String) body.get("instruction");
        List<String> fields = (List<String>) body.get("fields");
        return assist.command(instruction, fields);
    }

    @GetMapping("/qa")
    public List<QaPair> listQa() {
        return assist.listQa();
    }

    @PostMapping("/qa")
    public QaPair saveQa(@RequestBody Map<String, String> body) {
        return assist.saveQa(body.get("question"), body.get("answer"));
    }

    @PutMapping("/qa/{id}")
    public QaPair updateQa(@PathVariable UUID id, @RequestBody Map<String, String> body) {
        return assist.updateQa(id, body.get("question"), body.get("answer"));
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
