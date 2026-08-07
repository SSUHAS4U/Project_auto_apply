package com.jobpilot.agent;

import java.util.*;
import java.util.regex.Pattern;

/**
 * Decide the clear-cut jobs without a language model; send only the genuinely ambiguous ones on.
 *
 * WHY THIS EXISTS. A real run found 173 jobs and produced 4 "relevant". Not because 169 were
 * unsuitable — because 95 of them were never judged at all. Free-tier LLM quotas refill per
 * minute, a run evaluates faster than that, and everything that hit the limit was dumped on a
 * manual pile nobody works through. Meanwhile the verdicts that DID come back looked like this:
 *
 *     skip — stack mismatch — missing Python
 *     skip — stack mismatch — missing Flutter, Dart
 *     skip — senior/leadership role
 *
 * That is set arithmetic and a regex, dressed up as machine judgement, at the cost of a network
 * round trip and a quota unit each. Doing it here makes those decisions instant, free,
 * DETERMINISTIC (the same job always gets the same answer — a rate limit can no longer change
 * an outcome) and explainable in terms you can check.
 *
 * The model is kept for what it is actually good at: reading a vague description and judging
 * whether it is really your stack. That is the AMBIGUOUS band, and it should be a minority.
 */
public final class DeterministicFit {

    private DeterministicFit() { }

    /** What this layer concluded. AMBIGUOUS means "ask the model", not "no". */
    public enum Band { CLEAR_NO, CLEAR_YES, AMBIGUOUS }

    public record Verdict(Band band, int score, boolean techMatch,
                          List<String> matched, List<String> missing, String reason) { }

    /** Seniority the candidate is not applying for. Mirrors the worker's own filter. */
    private static final Pattern SENIOR = Pattern.compile(
            "\\b(senior|sr\\.?|lead|principal|staff|architect|manager|director|head\\s+of|vp|vice\\s*president)\\b",
            Pattern.CASE_INSENSITIVE);

    /**
     * A description this thin cannot be judged by ANY method. Below it, hand over rather than
     * inventing a verdict from a job title — the LLM at least gets to say "too vague".
     */
    private static final int MIN_JUDGEABLE_CHARS = 220;

    /**
     * @param candidateSkills the profile's skills, free-text (they arrive as the user typed them)
     * @param title           job title
     * @param description     the posting body
     */
    public static Verdict judge(Collection<String> candidateSkills, String title, String description) {
        String jobText = (title == null ? "" : title) + "\n" + (description == null ? "" : description);

        Set<String> mine = TechTaxonomy.extract(String.join(" , ", candidateSkills == null ? List.of() : candidateSkills));
        Set<String> myCore = TechTaxonomy.core(mine);
        // What the posting explicitly ASKS FOR — implications are not counted as separate
        // requirements. A React job implies JavaScript; that is one requirement, not two, and
        // counting it as two let a Python backend pass on its front end alone.
        Set<String> theirCore = TechTaxonomy.core(TechTaxonomy.extractExplicit(jobText));

        // Seniority is decided by the TITLE alone and is not a matter of opinion. The body often
        // says "work with senior engineers", which is not the same as being one.
        if (title != null && SENIOR.matcher(title).find()) {
            return new Verdict(Band.CLEAR_NO, 20, false, List.of(), List.of(),
                    "senior/leadership role");
        }

        // Nothing to reason about: no profile skills, or a posting too thin to name a stack.
        if (myCore.isEmpty()) {
            return new Verdict(Band.AMBIGUOUS, 0, false, List.of(), List.of(),
                    "no core skills recognised in the profile");
        }
        if (theirCore.isEmpty() || (description == null || description.length() < MIN_JUDGEABLE_CHARS)) {
            return new Verdict(Band.AMBIGUOUS, 0, false, List.of(), List.of(),
                    "the posting does not name a stack clearly");
        }

        Set<String> overlap = new LinkedHashSet<>(theirCore);
        overlap.retainAll(myCore);
        Set<String> absent = new LinkedHashSet<>(theirCore);
        absent.removeAll(myCore);

        List<String> matchedLabels = overlap.stream().map(TechTaxonomy::label).toList();
        List<String> missingLabels = absent.stream().map(TechTaxonomy::label).limit(4).toList();

        // ── CLEAR NO ──
        // The posting names core technologies and the candidate has NONE of them. A Python/Django
        // role for a Java/React developer is a different job, and no amount of prose changes that.
        if (overlap.isEmpty()) {
            return new Verdict(Band.CLEAR_NO, 15, false, List.of(), missingLabels,
                    "requires " + String.join(", ", missingLabels) + " — none of which are in your profile");
        }

        // ── CLEAR YES ──
        // Most of what the job asks for is what the candidate has. Two independent core matches
        // is the bar: one shared technology can be incidental (every backend job mentions SQL),
        // two is a stack. A majority requirement on top stops "we use Java, Python, Go and Rust"
        // from passing on Java alone.
        // Everything it asked for, you have. A posting naming only "Spring Boot" gives ONE
        // match and would fail a two-match bar — but there is nothing left to be unsure about,
        // and sending that to a model is exactly the waste this class exists to remove.
        double share = (double) overlap.size() / theirCore.size();
        if (absent.isEmpty()) {
            return new Verdict(Band.CLEAR_YES, 88, true, matchedLabels, List.of(),
                    "matches on " + String.join(", ", matchedLabels) + " — nothing missing");
        }
        if (overlap.size() >= 2 && share >= 0.5) {
            int score = (int) Math.round(60 + 35 * share);        // 78..95 in practice
            return new Verdict(Band.CLEAR_YES, Math.min(95, score), true, matchedLabels, missingLabels,
                    "matches on " + String.join(", ", matchedLabels));
        }

        // ── AMBIGUOUS ──
        // Partial overlap. This is the band the model is for: it can weigh whether the missing
        // pieces are central or incidental, which set arithmetic cannot.
        return new Verdict(Band.AMBIGUOUS, 0, false, matchedLabels, missingLabels,
                "partial overlap — matches " + String.join(", ", matchedLabels)
                + (missingLabels.isEmpty() ? "" : ", missing " + String.join(", ", missingLabels)));
    }
}
