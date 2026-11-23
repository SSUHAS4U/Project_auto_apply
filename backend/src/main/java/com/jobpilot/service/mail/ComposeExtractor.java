package com.jobpilot.service.mail;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Rules that read a pasted job post for the things Compose needs to send it: who to write to
 * (email, phone), the subject line the poster asked for, and — when the post labels them — the
 * role and company.
 *
 * Pure and deterministic, so it is unit-tested line by line. {@link ComposeService#extract}
 * runs these first and only then asks the AI, and an AI answer for a contact or a subject is
 * accepted only when it is literally in the post: a recipient address must never be invented.
 */
public final class ComposeExtractor {

    private ComposeExtractor() {}

    // ---- email -------------------------------------------------------------------------------

    private static final Pattern EMAIL =
            Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}");

    /** Domains that are never a real recruiter's address in a pasted post. */
    private static final List<String> PLACEHOLDER_DOMAINS = List.of("example.com", "example.org", "domain.com", "email.com");

    /** Every distinct address in the post, in the order they appear. */
    public static List<String> emails(String text) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        Matcher m = EMAIL.matcher(text);
        while (m.find()) {
            String e = m.group().replaceAll("[.]+$", "");
            String low = e.toLowerCase(Locale.ROOT);
            String domain = low.substring(low.indexOf('@') + 1);
            if (PLACEHOLDER_DOMAINS.contains(domain) || low.startsWith("your")) continue;
            if (out.stream().noneMatch(x -> x.equalsIgnoreCase(e))) out.add(e);
        }
        return out;
    }

    // ---- subject -----------------------------------------------------------------------------

    /** "Subject: X", "Subject line - X", "subject as X" — the rest of the line is the subject.
     *  A separator is REQUIRED after the word, so "salary subject to change" never matches. */
    private static final Pattern SUBJECT_LINE = Pattern.compile(
            "(?im)\\bsubject(?:\\s+line)?\\s*(?::|-|–|—|=|\\bas\\b|\\bshould\\s+be\\b|\\bmust\\s+be\\b)\\s*(.+)$");

    /** A quoted subject anywhere: mention "X" in the subject / subject line 'X'. */
    private static final Pattern SUBJECT_QUOTED_AFTER = Pattern.compile(
            "(?i)\\bsubject(?:\\s+line)?\\b[^\"“‘\\n]{0,25}?" + Q.OPEN + "([^\"“”\\n]{3,200}?)" + Q.CLOSE);
    private static final Pattern SUBJECT_QUOTED_BEFORE = Pattern.compile(
            "(?i)" + Q.OPEN + "([^\"“”\\n]{3,200}?)" + Q.CLOSE + "[^\"“‘\\n]{0,25}?\\b(?:in|as)\\s+(?:the\\s+)?subject\\b");

    /** Opening / closing quotes. A straight apostrophe counts only at a word edge, so the one
     *  in "candidate's name" is never taken for a quote. (A nested class so the constants are
     *  initialised before the patterns above that use them.) */
    private static final class Q {
        static final String OPEN = "(?:[\"“‘]|(?<![A-Za-z])')";
        static final String CLOSE = "(?:[\"”’]|'(?![A-Za-z]))";
    }

    /**
     * The subject line the post explicitly asks applicants to use, or null when it asks for none.
     * Placeholders are left as written; {@link #fillPlaceholders} completes them.
     */
    public static String subject(String text) {
        if (text == null || text.isBlank()) return null;
        for (Pattern p : List.of(SUBJECT_QUOTED_AFTER, SUBJECT_QUOTED_BEFORE)) {
            Matcher m = p.matcher(text);
            if (m.find()) {
                String s = cleanSubject(m.group(1));
                if (s != null) return s;
            }
        }
        Matcher m = SUBJECT_LINE.matcher(text);
        while (m.find()) {
            String s = cleanSubject(m.group(1));
            if (s != null) return s;
        }
        return null;
    }

    private static String cleanSubject(String raw) {
        if (raw == null) return null;
        String s = raw.strip()
                .replaceAll("^[\"“'‘]+|[\"”'’]+$", "")
                .replaceAll("[\\s.;,]+$", "")
                .strip();
        // "Subject: as mentioned above" and similar are directions, not a subject.
        if (s.length() < 3 || s.length() > 200) return null;
        if (s.matches("(?i)(?:to|of|as|mention.*|the|line|matter.*|expert.*)")) return null;
        if (!s.matches(".*[A-Za-z].*")) return null;
        return s;
    }

    private static final Pattern BRACKETED = Pattern.compile("[\\[<{(]\\s*([^\\]>})]{1,40}?)\\s*[\\]>})]");

    /**
     * Complete the placeholders posts put in a requested subject — "[Your Name]", "<Position>",
     * "{Role}" — with the candidate's name, the role and the company. A placeholder with no
     * known value is left as written so the user sees it in the field and can fill it.
     */
    public static String fillPlaceholders(String subject, String name, String role, String company) {
        if (subject == null) return null;
        Matcher m = BRACKETED.matcher(subject);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            String key = m.group(1).toLowerCase(Locale.ROOT);
            String value = null;
            if (key.contains("name") && !key.contains("company") && !key.contains("job")
                    && !key.contains("position") && !key.contains("role")) value = name;
            else if (key.contains("role") || key.contains("position") || key.contains("job")
                    || key.contains("title") || key.contains("designation") || key.contains("post")) value = role;
            else if (key.contains("company") || key.contains("organi")) value = company;
            m.appendReplacement(sb, Matcher.quoteReplacement(
                    value == null || value.isBlank() ? m.group() : value.strip()));
        }
        m.appendTail(sb);
        String out = sb.toString();
        if (name != null && !name.isBlank()) {
            out = out.replaceAll("(?i)\\b(?:your|full|candidate'?s?)\\s+name\\b", Matcher.quoteReplacement(name.strip()));
        }
        return out;
    }

    // ---- phone -------------------------------------------------------------------------------

    /** Digits with spaces, dashes, dots or brackets between them — never across a line break,
     *  so a chat timestamp on the next line ("470 14:01") is not glued to a number. */
    private static final Pattern PHONE = Pattern.compile("(?<![\\w+])(\\+?\\d[\\d \\t\\-().]{6,18}\\d)(?![\\w])");

    /** Phone numbers in the post as digits, most likely WhatsApp contact first: a number on a
     *  line that says WhatsApp, then Indian mobile numbers, then the rest, each in post order. */
    public static List<String> phones(String text) {
        if (text == null) return List.of();
        Map<String, Integer> scored = new LinkedHashMap<>();
        for (String line : text.split("\\R")) {
            boolean wa = line.toLowerCase(Locale.ROOT).contains("whatsapp");
            Matcher m = PHONE.matcher(line);
            while (m.find()) {
                String raw = m.group(1);
                String digits = raw.replaceAll("\\D", "");
                if (digits.length() < 10 || digits.length() > 13) continue;
                // A date or a range ("2024-2025", "10.5-12.5") is not a phone number.
                if (raw.matches("\\d{4}\\s*-\\s*\\d{4}")) continue;
                String key = (raw.startsWith("+") ? "+" : "") + digits;
                // "080-41234567": a trunk 0 + an area code, then a separator, is a landline even
                // though its digits would pass for a mobile once the 0 is stripped.
                boolean landline = raw.matches("0\\d{2,4}[ \\t\\-.)].*");
                int score = (wa ? 2 : 0) + (!landline && isIndianMobile(digits) ? 1 : 0);
                scored.merge(key, score, Math::max);
            }
        }
        List<Map.Entry<String, Integer>> entries = new ArrayList<>(scored.entrySet());
        entries.sort((a, b) -> b.getValue() - a.getValue()); // stable: equal scores keep post order
        List<String> out = new ArrayList<>();
        for (Map.Entry<String, Integer> e : entries) out.add(e.getKey());
        return out;
    }

    private static boolean isIndianMobile(String digits) {
        String d = digits;
        if (d.length() == 12 && d.startsWith("91")) d = d.substring(2);
        else if (d.length() == 11 && d.startsWith("0")) d = d.substring(1);
        return d.length() == 10 && d.charAt(0) >= '6' && d.charAt(0) <= '9';
    }

    /**
     * A number as WhatsApp wants it: digits only, with the country code, no "+" or leading zero.
     * A bare 10-digit number gets {@code defaultCountryCode}; "0" + 10 digits is a domestic
     * trunk prefix and is replaced by it. Returns null when the result can't be a phone number
     * (E.164 allows 8–15 digits), so the caller reports it instead of opening a broken chat.
     */
    public static String normalizePhone(String raw, String defaultCountryCode) {
        if (raw == null) return null;
        String t = raw.strip();
        if (t.isEmpty()) return null;
        boolean international = t.startsWith("+") || t.startsWith("00");
        String digits = t.replaceAll("\\D", "");
        if (t.startsWith("00")) digits = digits.substring(2);
        String cc = defaultCountryCode == null ? "" : defaultCountryCode.replaceAll("\\D", "");
        if (!international) {
            if (digits.length() == 11 && digits.startsWith("0")) digits = cc + digits.substring(1);
            else if (digits.length() == 10) digits = cc + digits;
        }
        if (digits.length() < 8 || digits.length() > 15 || digits.startsWith("0")) return null;
        return digits;
    }

    // ---- labelled role / company (used when the AI is off) ----------------------------------

    private static final Pattern ROLE_LABEL = Pattern.compile(
            "(?im)^\\s*(?:job\\s*title|role|position|designation|opening|post|profile)\\s*[:\\-–]\\s*(.{2,100}?)\\s*$");
    private static final Pattern COMPANY_LABEL = Pattern.compile(
            "(?im)^\\s*(?:company(?:\\s*name)?|organi[sz]ation|employer|client)\\s*[:\\-–]\\s*(.{2,100}?)\\s*$");
    /** "hiring a Java Full Stack Developer" — capitalised words ending in a role noun, so
     *  "hiring for multiple positions including …" captures nothing rather than a sentence. */
    private static final Pattern HIRING_FOR = Pattern.compile(
            "\\b(?i:hiring|looking)\\s+(?i:for\\s+)?(?i:an?\\s+|experienced\\s+|freshers?\\s+(?:for\\s+)?)?"
                    + "((?:[A-Z][A-Za-z+#./-]*\\s+){0,5}(?:Developer|Engineer|Intern|Analyst|Designer|Manager|Tester"
                    + "|Architect|Scientist|Consultant|Executive|Associate|Lead|Administrator|Specialist))s?\\b");

    /** The role when the post labels it ("Role: X") or says "hiring a X Developer"; else null. */
    public static String role(String text) {
        if (text == null) return null;
        Matcher m = ROLE_LABEL.matcher(text);
        if (m.find()) return tidy(m.group(1));
        m = HIRING_FOR.matcher(text);
        return m.find() ? tidy(m.group(1)) : null;
    }

    /** The company when the post labels it ("Company: X"); else null. */
    public static String company(String text) {
        if (text == null) return null;
        Matcher m = COMPANY_LABEL.matcher(text);
        return m.find() ? tidy(m.group(1)) : null;
    }

    /** Free-mail providers say nothing about the employer. */
    private static final List<String> FREE_MAIL = List.of(
            "gmail", "googlemail", "yahoo", "ymail", "outlook", "hotmail", "live", "icloud", "proton",
            "protonmail", "rediffmail", "zoho", "aol", "gmx", "mail");

    /** The employer's domain stem from a recruiter address ("hr@acme.co.in" → "acme"), or null
     *  for a free-mail address. Used to check an AI-suggested company against the post. */
    public static String domainStem(String email) {
        if (email == null || !email.contains("@")) return null;
        String domain = email.substring(email.indexOf('@') + 1).toLowerCase(Locale.ROOT);
        String[] parts = domain.split("\\.");
        if (parts.length < 2) return null;
        // acme.co.in → acme ; careers.acme.com → acme
        int idx = parts.length - 2;
        if (parts.length >= 3 && parts[idx].length() <= 3 && List.of("co", "com", "org", "net", "ac", "gov").contains(parts[idx])) idx--;
        String stem = parts[idx];
        return FREE_MAIL.contains(stem) ? null : stem;
    }

    private static String tidy(String s) {
        if (s == null) return null;
        String t = s.strip().replaceAll("[\\s.;,|]+$", "").replaceAll("\\s+", " ");
        return t.isEmpty() ? null : t;
    }

    /** Case- and whitespace-insensitive "does the post literally contain this". */
    public static boolean appearsIn(String needle, String haystack) {
        if (needle == null || haystack == null) return false;
        String n = needle.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ").strip();
        String h = haystack.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
        return !n.isEmpty() && h.contains(n);
    }
}
