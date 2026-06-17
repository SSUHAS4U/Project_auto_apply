package com.jobpilot.service;

import com.jobpilot.connector.RawJob;
import com.jobpilot.domain.Job;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Maps a RawJob to a Job, computing the dedupe hash and classifying apply_type. */
@Service
public class NormalizeService {

    private static final Pattern EMAIL =
            Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}");

    /** content_hash = sha256(lower(trim(company)) | lower(trim(title)) | lower(trim(location))) */
    public String contentHash(String company, String title, String location) {
        String basis = norm(company) + "|" + norm(title) + "|" + norm(location);
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(basis.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static String norm(String s) {
        return s == null ? "" : s.trim().toLowerCase(Locale.ROOT);
    }

    /** Fresh Job from a RawJob (no id). Caller decides insert vs. update. */
    public Job toJob(RawJob r) {
        Job j = new Job();
        applyInto(j, r);
        j.setContentHash(contentHash(r.getCompany(), r.getTitle(), r.getLocation()));
        return j;
    }

    /** Refresh mutable fields of an existing Job from a re-fetched RawJob. */
    public void refresh(Job j, RawJob r) {
        applyInto(j, r);
        j.setFetchedAt(Instant.now());
    }

    private void applyInto(Job j, RawJob r) {
        j.setSource(r.getSource());
        j.setSourceJobId(r.getSourceJobId());
        j.setTitle(r.getTitle());
        j.setCompany(r.getCompany());
        j.setLocation(r.getLocation());
        j.setRemote(r.isRemote());
        j.setDescription(r.getDescription());
        j.setUrl(r.getUrl());
        j.setSalaryText(r.getSalaryText());
        j.setPostedAt(r.getPostedAt());
        j.setRaw(r.getRaw());
        j.setFetchedAt(Instant.now());

        ApplyClassification c = classify(r);
        j.setApplyType(c.type());
        j.setApplyEmail(c.email());
    }

    /**
     * apply_type rules:
     *   - ATS connectors already set "ats" -> keep.
     *   - explicit apply_email -> "email".
     *   - description contains an apply email -> "email".
     *   - else "url" (unknown collapses to url).
     */
    public ApplyClassification classify(RawJob r) {
        if ("ats".equalsIgnoreCase(r.getApplyType())) {
            return new ApplyClassification("ats", null);
        }
        if (r.getApplyEmail() != null && !r.getApplyEmail().isBlank()) {
            return new ApplyClassification("email", r.getApplyEmail().trim());
        }
        String found = firstEmail(r.getDescription());
        if (found != null) {
            return new ApplyClassification("email", found);
        }
        String type = r.getApplyType();
        if (type == null || type.isBlank() || "unknown".equalsIgnoreCase(type)) {
            return new ApplyClassification("url", null);
        }
        return new ApplyClassification(type.toLowerCase(Locale.ROOT), null);
    }

    private String firstEmail(String text) {
        if (text == null) return null;
        Matcher m = EMAIL.matcher(text);
        while (m.find()) {
            String e = m.group();
            // Ignore obvious non-recruiting addresses.
            String lower = e.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".png") || lower.endsWith(".jpg")) continue;
            if (lower.contains("noreply") || lower.contains("no-reply")) continue;
            return e;
        }
        return null;
    }

    public record ApplyClassification(String type, String email) {}
}
