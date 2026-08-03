package com.jobpilot.agent;

import com.jobpilot.service.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * The limits that keep outreach from looking like spam — and from getting the owner's LinkedIn
 * account restricted.
 *
 * There were none of these: nothing stopped the same recruiter being contacted again on the next
 * run for the same role, and nothing stopped a single company receiving a dozen invitations in
 * one block.
 *
 * {@link #claim} is deliberately a single call that CHECKS AND RECORDS together. Two separate
 * calls would let a retry, or two quick loop iterations, both pass the check before either wrote
 * a row. The unique index on (user_id, outreach_hash) is the final backstop: if a duplicate
 * somehow reaches the insert, the database refuses it and we report the duplicate rather than
 * sending twice.
 */
@Service
public class OutreachGuard {

    private static final Logger log = LoggerFactory.getLogger(OutreachGuard.class);
    private static final ZoneId ZONE = ZoneId.of("Asia/Kolkata");

    private static final String PER_COMPANY_DAY = "outreach_per_company_day";
    private static final String PER_RECRUITER_DAYS = "outreach_per_recruiter_days";
    private static final String PER_DAY = "outreach_per_day";

    private final OutreachLogRepository logs;
    private final SettingsService settings;

    public OutreachGuard(OutreachLogRepository logs, SettingsService settings) {
        this.logs = logs;
        this.settings = settings;
    }

    /** The limits, editable without a rebuild. Defaults are the spec's numbers. */
    public Map<String, Object> limits() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("perCompanyPerDay", intOf(PER_COMPANY_DAY, 3));
        m.put("recruiterCooldownDays", intOf(PER_RECRUITER_DAYS, 7));
        m.put("perDay", intOf(PER_DAY, 20));
        return m;
    }

    public Map<String, Object> setLimits(Map<String, Object> body) {
        put(body, "perCompanyPerDay", PER_COMPANY_DAY, 1, 50);
        put(body, "recruiterCooldownDays", PER_RECRUITER_DAYS, 0, 90);
        put(body, "perDay", PER_DAY, 1, 200);
        return limits();
    }

    /**
     * May we contact this person, and if so record that we did.
     *
     * @return {@code {ok:true, hash}} when the outreach is allowed and now recorded, or
     *         {@code {ok:false, reason}} naming which limit stopped it.
     */
    @Transactional
    public Map<String, Object> claim(UUID userId, String portal, String company, String role,
                                     String recruiterUrl, String recruiterName, String resumeVersion) {
        String url = norm(recruiterUrl);
        if (url.isBlank()) return deny("no profile URL to identify this person by");

        String co = norm(company);
        String hash = hash(co, norm(role), url, norm(resumeVersion));
        Map<String, Object> lim = limits();

        // 1. Idempotency — this exact outreach has already gone out.
        if (logs.existsByUserIdAndOutreachHash(userId, hash)) {
            return deny("already contacted about this role");
        }

        // 2. This person, recently — regardless of role.
        int cooldown = (int) lim.get("recruiterCooldownDays");
        if (cooldown > 0 && logs.countByUserIdAndRecruiterUrlAndCreatedAtGreaterThanEqual(
                userId, url, Instant.now().minusSeconds(cooldown * 86400L)) > 0) {
            return deny("contacted within the last " + cooldown + " days");
        }

        Instant dayStart = LocalDate.now(ZONE).atStartOfDay(ZONE).toInstant();

        // 3. This company, today.
        int perCompany = (int) lim.get("perCompanyPerDay");
        if (!co.isBlank() && logs.countByUserIdAndCompanyAndCreatedAtGreaterThanEqual(userId, co, dayStart) >= perCompany) {
            return deny(perCompany + " already contacted at this company today");
        }

        // 4. Overall volume today.
        int perDay = (int) lim.get("perDay");
        if (logs.countByUserIdAndCreatedAtGreaterThanEqual(userId, dayStart) >= perDay) {
            return deny("daily outreach limit of " + perDay + " reached");
        }

        OutreachLog row = new OutreachLog();
        row.setUserId(userId);
        row.setPortal(portal == null ? "linkedin" : portal);
        row.setCompany(co);
        row.setRoleTitle(role);
        row.setRecruiterUrl(url);
        row.setRecruiterName(recruiterName);
        row.setOutreachHash(hash);
        try {
            logs.saveAndFlush(row);
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            // The unique index caught a duplicate that slipped past the check above — exactly
            // what it is there for. Report it as a duplicate, don't send.
            log.debug("outreach hash collision for {}: {}", userId, e.getMessage());
            return deny("already contacted about this role");
        }
        Map<String, Object> ok = new LinkedHashMap<>();
        ok.put("ok", true);
        ok.put("hash", hash);
        return ok;
    }

    private static Map<String, Object> deny(String reason) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", false);
        m.put("reason", reason);
        return m;
    }

    /** Stable key: same inputs ⇒ same hash across runs and restarts. */
    static String hash(String company, String role, String recruiterUrl, String resumeVersion) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest((company + "|" + role + "|" + recruiterUrl + "|" + resumeVersion)
                    .getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(64);
            for (byte b : d) sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            return sb.toString();
        } catch (Exception e) {
            // Never a real path (SHA-256 is always present); degrade to something deterministic.
            return Integer.toHexString((company + role + recruiterUrl + resumeVersion).hashCode());
        }
    }

    /** Trailing slashes, query strings and case must not create a "different" person. */
    private static String norm(String s) {
        if (s == null) return "";
        String t = s.trim().toLowerCase();
        int q = t.indexOf('?');
        if (q >= 0) t = t.substring(0, q);
        while (t.endsWith("/")) t = t.substring(0, t.length() - 1);
        return t.replaceAll("\\s+", " ");
    }

    private int intOf(String key, int fallback) {
        return settings.get(key).map(v -> {
            try { return Integer.parseInt(v); } catch (NumberFormatException e) { return fallback; }
        }).orElse(fallback);
    }

    private void put(Map<String, Object> body, String field, String key, int min, int max) {
        Object v = body == null ? null : body.get(field);
        if (v instanceof Number n) settings.put(key, String.valueOf(Math.max(min, Math.min(n.intValue(), max))));
    }
}
