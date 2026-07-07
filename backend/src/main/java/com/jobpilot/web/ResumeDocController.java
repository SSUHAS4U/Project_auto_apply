package com.jobpilot.web;

import com.jobpilot.domain.ResumeDoc;
import com.jobpilot.service.ResumeDocService;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Overleaf-style LaTeX resume builder (JWT, per user): named LaTeX docs, one BASE,
 * per-JD tailored copies, compile-to-PDF via the free texlive.net service.
 */
@RestController
@RequestMapping("/api/resumes")
public class ResumeDocController {

    private final ResumeDocService resumes;

    public ResumeDocController(ResumeDocService resumes) {
        this.resumes = resumes;
    }

    @GetMapping
    public List<ResumeDoc> list() {
        return resumes.list();
    }

    @GetMapping("/{id}")
    public ResumeDoc get(@PathVariable UUID id) {
        return resumes.get(id);
    }

    /** Create: {name, latex?, fromId?, blank?} — no latex/fromId → profile starter template. */
    @PostMapping
    public ResumeDoc create(@RequestBody Map<String, String> body) {
        UUID fromId = body.get("fromId") == null || body.get("fromId").isBlank()
                ? null : UUID.fromString(body.get("fromId"));
        boolean blank = "true".equalsIgnoreCase(body.get("blank"));
        return resumes.create(body.get("name"), body.get("latex"), fromId, blank);
    }

    @PutMapping("/{id}")
    public ResumeDoc update(@PathVariable UUID id, @RequestBody Map<String, String> body) {
        return resumes.update(id, body.get("name"), body.get("latex"));
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable UUID id) {
        resumes.delete(id);
        return Map.of("deleted", true);
    }

    @PostMapping("/{id}/base")
    public ResumeDoc setBase(@PathVariable UUID id) {
        return resumes.setBase(id);
    }

    /** Compile the LaTeX to PDF (stores it) and return the PDF bytes. */
    @PostMapping("/{id}/compile")
    public ResponseEntity<byte[]> compile(@PathVariable UUID id) {
        byte[] pdf = resumes.compile(id);
        return pdfResponse(pdf, resumes.get(id).getName());
    }

    /** The last compiled PDF. */
    @GetMapping("/{id}/pdf")
    public ResponseEntity<byte[]> pdf(@PathVariable UUID id) {
        return pdfResponse(resumes.pdf(id), resumes.get(id).getName());
    }

    /** Duplicate the base resume tailored to a JD: {name?, jobUrl?, jdText}. */
    @PostMapping("/tailor")
    public ResumeDoc tailor(@RequestBody Map<String, String> body) {
        return resumes.tailor(body.get("name"), body.get("jobUrl"), body.get("jdText"));
    }

    private static ResponseEntity<byte[]> pdfResponse(byte[] pdf, String name) {
        String safe = (name == null ? "resume" : name).replaceAll("[^A-Za-z0-9 _-]", "").trim();
        if (safe.isEmpty()) safe = "resume";
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + safe + ".pdf\"")
                .body(pdf);
    }
}
