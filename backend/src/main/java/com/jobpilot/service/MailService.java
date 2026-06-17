package com.jobpilot.service;

import com.jobpilot.config.JobPilotProperties;
import jakarta.mail.internet.MimeMessage;
import org.springframework.core.io.FileSystemResource;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Service;

import java.nio.file.Path;

/** Thin wrapper over JavaMailSender for plain + attachment + HTML mail. */
@Service
public class MailService {

    private final JavaMailSender sender;
    private final JobPilotProperties props;

    public MailService(JavaMailSender sender, JobPilotProperties props) {
        this.sender = sender;
        this.props = props;
    }

    public void sendWithAttachment(String to, String subject, String textBody,
                                   Path attachment, String attachmentName) {
        try {
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
        } catch (Exception e) {
            throw new IllegalStateException("failed to send email: " + e.getMessage(), e);
        }
    }

    public void sendHtml(String to, String subject, String htmlBody) {
        try {
            MimeMessage msg = sender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(msg, false, "UTF-8");
            helper.setFrom(from());
            helper.setTo(to);
            helper.setSubject(subject);
            helper.setText(htmlBody, true);
            sender.send(msg);
        } catch (Exception e) {
            throw new IllegalStateException("failed to send email: " + e.getMessage(), e);
        }
    }

    private String from() {
        String f = props.getMail().getFrom();
        return (f == null || f.isBlank()) ? "no-reply@jobpilot.local" : f;
    }
}
