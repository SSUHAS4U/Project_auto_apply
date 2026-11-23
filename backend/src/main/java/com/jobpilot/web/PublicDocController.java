package com.jobpilot.web;

import com.jobpilot.service.NotFoundException;
import com.jobpilot.service.documents.ResumeDocService;
import com.jobpilot.service.mail.ShareLinkService;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;

/**
 * The ONE unauthenticated document route: a résumé / cover letter behind a WhatsApp share link.
 * The recipient is a recruiter with no JobPilot account, so the token is the only credential;
 * AuthFilter lets exactly this prefix through.
 */
@RestController
public class PublicDocController {

    private final ShareLinkService links;

    public PublicDocController(ShareLinkService links) {
        this.links = links;
    }

    @GetMapping("/api/public/doc/{token}")
    public ResponseEntity<byte[]> doc(@PathVariable String token) {
        try {
            ResumeDocService.ResumeFile f = links.resolve(token);
            return ResponseEntity.ok()
                    .contentType(MediaType.parseMediaType(f.contentType()))
                    .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + f.filename() + "\"")
                    .header(HttpHeaders.CACHE_CONTROL, "private, no-store")
                    .header("X-Robots-Tag", "noindex, nofollow")
                    .header("X-Content-Type-Options", "nosniff")
                    .body(f.data());
        } catch (ShareLinkService.Expired e) {
            return text(HttpStatus.GONE, e.getMessage());
        } catch (NotFoundException e) {
            return text(HttpStatus.NOT_FOUND, "This link doesn't exist. Check you copied all of it, or ask the sender for a fresh one.");
        }
    }

    private static ResponseEntity<byte[]> text(HttpStatus status, String msg) {
        return ResponseEntity.status(status).contentType(MediaType.TEXT_PLAIN)
                .header("X-Robots-Tag", "noindex, nofollow")
                .body(msg.getBytes(StandardCharsets.UTF_8));
    }
}
