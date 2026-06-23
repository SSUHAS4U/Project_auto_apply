package com.jobpilot.service;

import com.jobpilot.config.JobPilotProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/**
 * Sends transactional email via Brevo's HTTPS API (https://api.brevo.com/v3/smtp/email).
 * Cloud hosts like Render block outbound SMTP ports, so we use HTTPS instead — same
 * deliverability, no port 587/465 needed.
 */
@Component
public class BrevoMailClient {

    private static final Logger log = LoggerFactory.getLogger(BrevoMailClient.class);
    private static final String ENDPOINT = "https://api.brevo.com/v3/smtp/email";

    private final RestClient http;
    private final JobPilotProperties props;

    public BrevoMailClient(RestClient http, JobPilotProperties props) {
        this.http = http;
        this.props = props;
    }

    public boolean isConfigured() {
        String k = props.getMail().getBrevoApiKey();
        return k != null && !k.isBlank();
    }

    public void send(String to, String subject, String html, boolean isHtml, Path attachment, String attachmentName) {
        byte[] data = null;
        if (attachment != null) {
            try { data = Files.readAllBytes(attachment); }
            catch (Exception e) { log.warn("Brevo: could not read attachment {} ({})", attachmentName, e.getMessage()); }
        }
        sendBytes(to, subject, html, isHtml, data, attachmentName, null);
    }

    public void sendBytes(String to, String subject, String html, boolean isHtml,
                          byte[] attachment, String attachmentName, String bcc) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sender", Map.of(
                "email", props.getMail().getFrom(),
                "name", props.getMail().getFromName() == null ? "JobPilot" : props.getMail().getFromName()));
        body.put("to", List.of(Map.of("email", to)));
        if (bcc != null && !bcc.isBlank() && !bcc.equalsIgnoreCase(to)) {
            body.put("bcc", List.of(Map.of("email", bcc)));
        }
        body.put("subject", subject);
        if (isHtml) body.put("htmlContent", html);
        else body.put("textContent", html);

        if (attachment != null && attachment.length > 0) {
            String b64 = Base64.getEncoder().encodeToString(attachment);
            body.put("attachment", List.of(Map.of("content", b64, "name", attachmentName)));
        }

        post(to, subject, body);
    }

    /** Send with multiple attachments (cover-letter PDF + resume). */
    public void sendMulti(String to, String subject, String content, boolean isHtml,
                          java.util.List<MailAttachment> attachments, String bcc) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sender", Map.of(
                "email", props.getMail().getFrom(),
                "name", props.getMail().getFromName() == null ? "JobPilot" : props.getMail().getFromName()));
        body.put("to", List.of(Map.of("email", to)));
        if (bcc != null && !bcc.isBlank() && !bcc.equalsIgnoreCase(to)) {
            body.put("bcc", List.of(Map.of("email", bcc)));
        }
        body.put("subject", subject);
        if (isHtml) body.put("htmlContent", content); else body.put("textContent", content);

        if (attachments != null && !attachments.isEmpty()) {
            List<Map<String, Object>> atts = new ArrayList<>();
            for (MailAttachment a : attachments) {
                if (a != null && a.bytes() != null && a.bytes().length > 0) {
                    atts.add(Map.of("content", Base64.getEncoder().encodeToString(a.bytes()), "name", a.name()));
                }
            }
            if (!atts.isEmpty()) body.put("attachment", atts);
        }
        post(to, subject, body);
    }

    private void post(String to, String subject, Map<String, Object> body) {
        try {
            http.post().uri(ENDPOINT)
                    .header("api-key", props.getMail().getBrevoApiKey())
                    .header("accept", "application/json")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .toBodilessEntity();
            log.info("Brevo email sent to={} subject='{}'", to, subject);
        } catch (Exception e) {
            log.error("Brevo send failed to={} from={}: {}", to, props.getMail().getFrom(), e.getMessage(), e);
            throw new IllegalStateException("failed to send email to " + to + " via Brevo: " + e.getMessage(), e);
        }
    }
}
