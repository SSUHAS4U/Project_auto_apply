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
        j.setRegion(region(r.getLocation(), r.isRemote()));
    }

    private static final String[] INDIA_HINTS = {
            "india", "bengaluru", "bangalore", "hyderabad", "pune", "chennai", "mumbai",
            "delhi", "gurgaon", "gurugram", "noida", "kolkata", "ahmedabad", "jaipur",
            "kochi", "coimbatore", "indore", "chandigarh", "trivandrum", "thiruvananthapuram",
            "visakhapatnam", "vizag", "vijayawada", "guntur", "nagpur", "lucknow", "surat",
            "bhubaneswar", "mysore", "mysuru", "mangalore", "mangaluru", "vadodara", "thane",
            "navi mumbai", "faridabad", "ghaziabad", "mohali", "dehradun", "nashik", "raipur",
            "kanpur", "patna", "bhopal", "karnataka", "telangana", "maharashtra", "tamil nadu",
            "andhra pradesh", "kerala", "gujarat", "haryana", "uttar pradesh", "west bengal"
    };

    private static final String[] REMOTE_WORDS = {
            "remote", "anywhere", "worldwide", "global", "distributed", "wfh", "work from home"
    };

    /**
     * india | remote | outside | unknown.
     * "remote" means a location-agnostic role (so it belongs in the India tab). A role flagged
     * remote but tied to a concrete foreign city (e.g. "San Francisco") is "outside".
     */
    public String region(String location, boolean remote) {
        String loc = location == null ? "" : location.toLowerCase(Locale.ROOT);
        for (String h : INDIA_HINTS) {
            if (loc.contains(h)) return "india";
        }
        if (loc.isBlank()) return remote ? "remote" : "unknown";
        // Strip remote-ish words; if nothing concrete remains, it's a global remote role.
        String residue = loc;
        for (String w : REMOTE_WORDS) residue = residue.replace(w, " ");
        residue = residue.replaceAll("[^a-z]", "");
        if (residue.isEmpty()) return "remote";   // pure "Remote"/"Anywhere"/"Worldwide"
        return "outside";                          // concrete non-India place (even if remote-flagged)
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

    // Software-development roles we want.
    private static final Pattern TECH = Pattern.compile(
            "(software (engineer|developer)|\\bsde\\b|\\bsdet\\b|backend|back.?end|frontend|front.?end|" +
            "full.?stack|web developer|application (developer|engineer)|mobile (developer|engineer)|" +
            "android (developer|engineer)|ios (developer|engineer)|\\bdeveloper\\b|programmer|" +
            "devops|\\bsre\\b|site reliability|platform engineer|cloud engineer|infrastructure engineer|" +
            "data (engineer|scientist)|machine learning engineer|\\bml engineer\\b|mlops|ai engineer|" +
            "security engineer|qa engineer|test (engineer|automation)|automation engineer|embedded|firmware|" +
            "blockchain (developer|engineer)|game (developer|engineer)|" +
            "\\bjava\\b|python|javascript|typescript|\\breact\\b|angular|node\\.?js|golang|kotlin|" +
            "\\.net|c\\+\\+|\\brust\\b|\\bscala\\b|spring boot|\\bml\\b/ai|engineer.{0,12}(software|backend|frontend|data|cloud|devops|platform))",
            Pattern.CASE_INSENSITIVE);

    // Roles to drop even if a tech word slips in (support/ops/sales/design/mgmt/etc.).
    private static final Pattern NON_TECH = Pattern.compile(
            "(vkyc|v-kyc|\\bkyc\\b|telecall|tele.?caller|\\bbpo\\b|business development|\\bbde\\b|" +
            "relationship manager|collection|recovery|field (executive|sales|officer)|delivery (boy|partner|executive)|" +
            "\\bdriver\\b|warehouse|\\bnurse\\b|accountant|recruit(er|ment)|talent acquisition|" +
            "content writer|voice process|non.?voice|data entry|back office|cashier|teller|inside sales|" +
            "territory|store manager|beautician|chef|security guard|housekeeping|" +
            // support / operations / design / management / sales / analyst (non-SWE)
            "support (engineer|associate|specialist|analyst|operations|technician|representative)|" +
            "(customer|technical|product|designated|application) support|support (operations|engineer)|" +
            "\\boperations\\b|operations associate|service delivery|" +
            "\\bdesigner\\b|product designer|ux designer|ui designer|graphic designer|visual designer|" +
            "product manager|program manager|project manager|scrum master|delivery manager|account manager|" +
            "business analyst|customer success|\\bmarketing\\b|\\bsales\\b|presales|pre.?sales|" +
            "consultant|implementation|solution(s)? consultant)",
            Pattern.CASE_INSENSITIVE);

    /** True if the role title looks like a software-development job (drops support/ops/sales/design). */
    public boolean isTechRole(String title) {
        if (title == null || title.isBlank()) return false;
        String t = title.toLowerCase(Locale.ROOT);
        if (NON_TECH.matcher(t).find()) return false;
        return TECH.matcher(t).find();
    }
}
