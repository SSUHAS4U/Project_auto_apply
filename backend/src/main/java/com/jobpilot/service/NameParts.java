package com.jobpilot.service;

import com.jobpilot.domain.Profile;

/**
 * Splits a stored full name into the First / Middle / Last boxes application forms ask for.
 *
 * <p>The profile holds one name; almost every ATS wants two or three. Anything the user typed
 * explicitly wins — the split below is only the fallback, because no heuristic can be right
 * for every naming convention.
 *
 * <p>The one convention worth encoding: in much of South India the leading single letter is an
 * initial standing for the family/father's name, so "S Suhas" is given-name <em>Suhas</em>,
 * surname <em>S</em> — not first-name "S". Treating that token as a first name puts a bare
 * letter in the First name box of every form.
 */
public record NameParts(String first, String middle, String last) {

    /** True for "S", "S.", "K" — a surname initial, not a name. */
    private static boolean isInitial(String tok) {
        return tok.length() == 1 || (tok.length() == 2 && tok.endsWith("."));
    }

    public static NameParts of(String fullName) {
        String[] tok = (fullName == null ? "" : fullName).trim().split("\\s+");
        if (tok.length == 0 || tok[0].isEmpty()) return new NameParts("", "", "");
        if (tok.length == 1) return new NameParts(tok[0], "", "");

        // Leading initial(s): "S Suhas", "B N Prakash" -> the trailing word is the given name.
        int lead = 0;
        while (lead < tok.length - 1 && isInitial(tok[lead])) lead++;
        if (lead > 0) {
            String surnameInitials = String.join(" ", java.util.Arrays.copyOfRange(tok, 0, lead));
            String given = String.join(" ", java.util.Arrays.copyOfRange(tok, lead, tok.length));
            String[] g = given.split("\\s+");
            return g.length == 1
                    ? new NameParts(g[0], "", surnameInitials)
                    : new NameParts(g[0], String.join(" ", java.util.Arrays.copyOfRange(g, 1, g.length - 1)),
                                    g[g.length - 1]);
        }

        // Ordinary Western order: first, everything-in-between, last.
        String middle = tok.length > 2
                ? String.join(" ", java.util.Arrays.copyOfRange(tok, 1, tok.length - 1)) : "";
        return new NameParts(tok[0], middle, tok[tok.length - 1]);
    }

    /** Explicit profile fields win; anything blank falls back to the split. */
    public static NameParts of(Profile p) {
        NameParts d = of(p.getFullName());
        return new NameParts(
                blank(p.getFirstName()) ? d.first() : p.getFirstName().trim(),
                blank(p.getMiddleName()) ? d.middle() : p.getMiddleName().trim(),
                blank(p.getLastName()) ? d.last() : p.getLastName().trim());
    }

    private static boolean blank(String s) { return s == null || s.isBlank(); }
}
