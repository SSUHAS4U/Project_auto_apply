package com.jobpilot.service;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.Job;
import com.jobpilot.repository.JobRepository;
import jakarta.persistence.criteria.Predicate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Feature #4 — daily digest. Selects jobs fetched since the last digest with
 * match_score >= threshold, emails an HTML summary, records a notification, and
 * advances the watermark. Triggered by a GitHub Actions cron.
 */
@Service
public class DigestService {

    private static final Logger log = LoggerFactory.getLogger(DigestService.class);

    private final JobRepository jobRepo;
    private final SettingsService settings;
    private final NotificationService notifications;
    private final MailService mail;
    private final JobPilotProperties props;

    public DigestService(JobRepository jobRepo,
                         SettingsService settings,
                         NotificationService notifications,
                         MailService mail,
                         JobPilotProperties props) {
        this.jobRepo = jobRepo;
        this.settings = settings;
        this.notifications = notifications;
        this.mail = mail;
        this.props = props;
    }

    public Map<String, Object> run() {
        int threshold = props.getDigest().getMinScore();
        Instant since = settings.getInstant("last_digest_at")
                .orElse(Instant.now().minus(1, ChronoUnit.DAYS));

        List<Job> matches = jobRepo.findAll(highMatchSince(since, threshold),
                PageRequest.of(0, 30, Sort.by(Sort.Order.desc("matchScore")))).getContent();

        Map<String, Object> result = new HashMap<>();
        result.put("threshold", threshold);
        result.put("since", since.toString());
        result.put("count", matches.size());

        if (matches.isEmpty()) {
            settings.setInstant("last_digest_at", Instant.now());
            result.put("sent", false);
            return result;
        }

        String html = renderHtml(matches, threshold);
        notifications.create("digest",
                matches.size() + " new high-match jobs",
                "Digest with " + matches.size() + " jobs at score >= " + threshold,
                Map.of("jobIds", matches.stream().map(j -> j.getId().toString()).toList()));

        boolean sent = false;
        String to = props.getMail().getDigestTo();
        if (to != null && !to.isBlank()) {
            try {
                mail.sendHtml(to, "JobPilot digest — " + matches.size() + " new matches", html);
                sent = true;
            } catch (Exception e) {
                log.warn("Digest email failed: {}", e.getMessage());
            }
        }
        settings.setInstant("last_digest_at", Instant.now());
        result.put("sent", sent);
        return result;
    }

    private Specification<Job> highMatchSince(Instant since, int threshold) {
        return (root, query, cb) -> {
            List<Predicate> ps = new ArrayList<>();
            ps.add(cb.greaterThanOrEqualTo(root.get("fetchedAt"), since));
            ps.add(cb.greaterThanOrEqualTo(root.get("matchScore"), threshold));
            return cb.and(ps.toArray(new Predicate[0]));
        };
    }

    private String renderHtml(List<Job> jobs, int threshold) {
        StringBuilder sb = new StringBuilder();
        sb.append("<div style=\"font-family:system-ui,Arial,sans-serif;max-width:640px;margin:auto\">");
        sb.append("<h2 style=\"color:#4f46e5\">JobPilot — ").append(jobs.size())
                .append(" new matches (score &ge; ").append(threshold).append(")</h2>");
        for (Job j : jobs) {
            sb.append("<div style=\"border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin:10px 0\">");
            sb.append("<div style=\"font-weight:600;font-size:15px\">")
                    .append(esc(j.getTitle())).append("</div>");
            sb.append("<div style=\"color:#6b7280;font-size:13px\">")
                    .append(esc(j.getCompany())).append(" · ").append(esc(j.getLocation())).append("</div>");
            sb.append("<div style=\"font-size:12px;margin:6px 0\">Match: <b>")
                    .append(j.getMatchScore()).append("</b> · ").append(esc(j.getApplyType())).append("</div>");
            sb.append("<a href=\"").append(esc(j.getUrl()))
                    .append("\" style=\"color:#4f46e5;font-size:13px\">View posting →</a>");
            sb.append("</div>");
        }
        sb.append("</div>");
        return sb.toString();
    }

    private String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
