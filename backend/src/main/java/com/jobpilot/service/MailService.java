package com.jobpilot.service;

import com.jobpilot.config.JobPilotProperties;
import jakarta.mail.internet.MimeMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.FileSystemResource;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Service;

import java.nio.file.Path;

/** Thin wrapper over JavaMailSender for plain + attachment + HTML mail. */
@Service
public class MailService {

    private static final Logger log = LoggerFactory.getLogger(MailService.class);

    private final JavaMailSender sender;
    private final BrevoMailClient brevo;
    private final JobPilotProperties props;

    public MailService(JavaMailSender sender, BrevoMailClient brevo, JobPilotProperties props) {
        this.sender = sender;
        this.brevo = brevo;
        this.props = props;
        // Log mail configuration at startup so Render logs show whether it's wired up.
        log.info("MailService initialised — transport={}, from='{}', digestTo='{}'",
                brevo.isConfigured() ? "Brevo (HTTPS API)" : "SMTP",
                props.getMail().getFrom(), props.getMail().getDigestTo());
    }

    public void sendWithAttachment(String to, String subject, String textBody,
                                   Path attachment, String attachmentName) {
        if (brevo.isConfigured()) {
            brevo.send(to, subject, textBody, false, attachment, attachmentName);
            return;
        }
        try {
            log.info("Sending email (attachment) to={} subject='{}'", to, subject);
            MimeMessage msg = sender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(msg, true, "UTF-8");
            helper.setFrom(from());
            helper.setTo(to);
            helper.setSubject(subject);
            helper.setText(textBody, false);
            if (attachment != null) {
                helper.addAttachment(attachmentName, new FileSystemResource(attachment));
            }
            sender.send(msg);
            log.info("Email sent successfully to={}", to);
        } catch (Exception e) {
            log.error("Failed to send email to={} from={}: {}", to, from(), e.getMessage(), e);
            throw new IllegalStateException("failed to send email to " + to + ": " + e.getMessage(), e);
        }
    }

    public void sendHtml(String to, String subject, String htmlBody) {
        if (brevo.isConfigured()) {
            brevo.send(to, subject, htmlBody, true, null, null);
            return;
        }
        try {
            log.info("Sending HTML email to={} subject='{}'", to, subject);
            MimeMessage msg = sender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(msg, false, "UTF-8");
            helper.setFrom(from());
            helper.setTo(to);
            helper.setSubject(subject);
            helper.setText(htmlBody, true);
            sender.send(msg);
            log.info("HTML email sent successfully to={}", to);
        } catch (Exception e) {
            log.error("Failed to send HTML email to={} from={}: {}", to, from(), e.getMessage(), e);
            throw new IllegalStateException("failed to send email to " + to + ": " + e.getMessage(), e);
        }
    }

    private String from() {
        String f = props.getMail().getFrom();
        if (f == null || f.isBlank()) {
            log.warn("JOBPILOT_MAIL_FROM is blank — using fallback 'no-reply@jobpilot.local'. "
                    + "Gmail SMTP will likely REJECT this. Set the env var to your Gmail address.");
            return "no-reply@jobpilot.local";
        }
        return f;
    }
}
