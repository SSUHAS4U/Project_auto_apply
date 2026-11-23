package com.jobpilot.web;

import com.jobpilot.service.mail.ComposeService;
import com.jobpilot.service.mail.ShareLinkService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/compose")
public class ComposeController {

    private final ComposeService compose;
    private final ShareLinkService links;

    public ComposeController(ComposeService compose, ShareLinkService links) {
        this.compose = compose;
        this.links = links;
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

    /** Read a pasted job post: role, company, recipient email, requested subject, phone. */
    @PostMapping("/extract")
    public Map<String, Object> extract(@RequestBody Map<String, String> body) {
        return compose.extract(body.get("text"));
    }

    /** Send the composed email (cold email + cover letter + the chosen résumé) to a recipient. */
    @PostMapping("/send")
    public Map<String, Object> send(@RequestBody Map<String, Object> body) {
        return compose.send(
                (String) body.get("to"),
                (String) body.get("subject"),
                (String) body.get("coldEmail"),
                (String) body.get("coverLetter"),
                Boolean.TRUE.equals(body.get("attachResume")),
                uuid(body.get("resumeId")),
                (String) body.get("company"),
                (String) body.get("role"));
    }

    /** Prepare a WhatsApp click-to-chat link carrying the message + résumé/cover-letter links. */
    @PostMapping("/whatsapp")
    public Map<String, Object> whatsapp(@RequestBody Map<String, Object> body, HttpServletRequest req) {
        return compose.whatsapp(
                (String) body.get("phone"),
                (String) body.get("message"),
                (String) body.get("company"),
                (String) body.get("role"),
                uuid(body.get("resumeId")),
                Boolean.TRUE.equals(body.get("includeResume")),
                (String) body.get("coverLetter"),
                publicBase(req));
    }

    /**
     * Where a recruiter's phone reaches this API. The configured JOBPILOT_PUBLIC_BASE_URL wins;
     * otherwise the address this request came in on — behind Caddy the Host header is the
     * public one and X-Forwarded-Proto says https.
     */
    private String publicBase(HttpServletRequest req) {
        String configured = links.configuredBaseUrl();
        if (!configured.isEmpty()) return configured;
        String proto = req.getHeader("X-Forwarded-Proto");
        if (proto == null || !(proto.equals("http") || proto.equals("https"))) proto = req.getScheme();
        String host = req.getHeader("Host");
        if (host == null || !host.matches("[A-Za-z0-9.:\\[\\]-]{1,255}")) host = req.getServerName() + ":" + req.getServerPort();
        return proto + "://" + host;
    }

    private static UUID uuid(Object v) {
        if (!(v instanceof String s) || s.isBlank()) return null;
        try {
            return UUID.fromString(s.strip());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("That résumé choice isn't valid — pick the résumé again.");
        }
    }
}
