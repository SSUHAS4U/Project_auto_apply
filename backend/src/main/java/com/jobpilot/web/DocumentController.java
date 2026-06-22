package com.jobpilot.web;

import com.jobpilot.service.DocumentService;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Per-user document vault (encrypted at rest, password-gated downloads). */
@RestController
@RequestMapping("/api/documents")
public class DocumentController {

    private final DocumentService docs;

    public DocumentController(DocumentService docs) {
        this.docs = docs;
    }

    @GetMapping
    public List<Map<String, Object>> list() {
        return docs.list();
    }

    @PostMapping
    public Map<String, Object> upload(@RequestParam("file") MultipartFile file,
                                      @RequestParam(value = "name", required = false) String name,
                                      @RequestParam(value = "type", required = false) String type) {
        return docs.store(file, name, type);
    }

    /** Re-auth with the account password, then stream the decrypted file. */
    @PostMapping("/{id}/download")
    public ResponseEntity<ByteArrayResource> download(@PathVariable UUID id,
                                                      @RequestBody Map<String, String> body) {
        DocumentService.Download d = docs.download(id, body == null ? null : body.get("password"));
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(d.contentType() == null ? "application/octet-stream" : d.contentType()))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + d.filename() + "\"")
                .body(new ByteArrayResource(d.bytes()));
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable UUID id) {
        docs.delete(id);
        return Map.of("deleted", true);
    }
}
