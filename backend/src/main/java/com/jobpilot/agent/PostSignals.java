package com.jobpilot.agent;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Is this LinkedIn post announcing a job? Answered from the words, before spending a model call.
 *
 * Same reasoning as {@link DeterministicFit}, applied to the other high-volume decision in the
 * automation. Post scan is budgeted for 150 posts a run and every one of them currently costs an
 * LLM call to classify — at a free tier's per-minute ceiling that is ten-plus minutes of pure
 * quota, and it is the exact failure the fit gate just escaped, where 95 of 108 jobs went
 * unjudged because the allowance ran out mid-run.
 *
 * Hiring posts announce themselves. "We are hiring", "share your resume", "DM me", "open
 * position" — that is most of the corpus, and it is a phrase match, not a judgement. The model
 * is kept for posts that genuinely read either way.
 */
public final class PostSignals {

    private PostSignals() { }

    public enum Band { CLEAR_HIRING, CLEAR_NOT, AMBIGUOUS }

    public record Signal(Band band, int confidence, String role, String reason) { }

    /**
     * Unmistakable "there is a job here" phrasing.
     *
     * Every one of these is a recruiter TELLING you to act. A post that contains one is not
     * ambiguous, and asking a model about it is pure cost.
     */
    private static final List<Pattern> HIRING = compile(
            "we(?:'re| are)\\s+hiring",
            "\\bi(?:'m| am)\\s+hiring",
            "\\bnow\\s+hiring",
            "\\bhiring\\s+(?:for|a|an|multiple|urgently)",
            "\\b(?:urgent|immediate)\\s+(?:requirement|opening|hiring)",
            "\\bopen(?:ing)?s?\\s+(?:for|at|in)\\b",
            "\\bjob\\s+opening",
            "\\bwe\\s+have\\s+an?\\s+opening",
            "\\bposition[s]?\\s+(?:open|available)",
            "\\blooking\\s+for\\s+(?:a|an|experienced|passionate|talented|\\d)",
            "\\bshare\\s+(?:your\\s+)?(?:cv|resume|profile)",
            "\\bsend\\s+(?:your\\s+)?(?:cv|resume|profile)",
            "\\b(?:dm|pm|inbox)\\s+me\\b",
            "\\bdrop\\s+(?:your\\s+)?(?:cv|resume)",
            "\\binterested\\s+candidates?\\b",
            "\\bapply\\s+(?:now|here|at|via|through)",
            "\\bwalk[- ]?in\\s+(?:drive|interview)",
            "\\bnotice\\s+period\\b",
            "\\bexperience\\s*:\\s*\\d",
            "\\bctc\\b");

    /**
     * Phrases that mean the writer is LOOKING for work, not offering it.
     *
     * These matter more than they look. A jobseeker's post contains "share my profile" and
     * "immediate joiner" too, and messaging one is both useless and slightly humiliating for
     * everyone involved — so an explicit seeking signal overrides the hiring ones.
     */
    private static final List<Pattern> SEEKING = compile(
            "\\bopen\\s+to\\s+work\\b",
            "\\blooking\\s+for\\s+(?:a\\s+)?(?:new\\s+)?(?:job|role|opportunit)",
            "\\bseeking\\s+(?:a\\s+)?(?:new\\s+)?(?:job|role|opportunit|position)",
            "\\b(?:my|i\\s+have)\\s+\\d+\\+?\\s*(?:years|yrs)\\s+of\\s+experience\\b.{0,80}\\b(?:looking|seeking|available)",
            "\\bplease\\s+refer\\s+me\\b",
            "\\bany\\s+(?:leads|referrals)\\s+(?:would\\s+be\\s+)?appreciated",
            "\\bi\\s+(?:was|got)\\s+(?:laid\\s+off|impacted)",
            "\\bactively\\s+(?:looking|seeking)\\b");

    /** Nothing to do with jobs at all — congratulations, launches, opinions. */
    private static final List<Pattern> NOT_HIRING = compile(
            "\\bcongratulations\\b",
            "\\bhappy\\s+to\\s+(?:share|announce)\\b.{0,60}\\b(?:certif|course|completed|joined)",
            "\\bthrilled\\s+to\\s+announce\\b.{0,60}\\bjoin(?:ed|ing)\\b",
            "\\bcompleted\\s+(?:my|the)\\s+.{0,40}(?:certification|course)");

    private static List<Pattern> compile(String... res) {
        List<Pattern> out = new ArrayList<>(res.length);
        for (String r : res) out.add(Pattern.compile(r, Pattern.CASE_INSENSITIVE));
        return out;
    }

    private static int count(List<Pattern> pats, String t) {
        int n = 0;
        for (Pattern p : pats) if (p.matcher(t).find()) n++;
        return n;
    }

    /** Words that follow "hiring" without naming a role. On their own they say nothing. */
    private static final Set<String> GENERIC = Set.of(
            "people", "someone", "somebody", "folks", "talent", "talents", "candidates",
            "candidate", "individuals", "professionals", "members", "team members", "staff",
            "engineers now", "you", "us", "them", "more people", "great people", "top talent");

    /** The role being hired for, when the post states it plainly. Empty when it does not. */
    private static final Pattern ROLE = Pattern.compile(
            "\\b(?:hiring|looking\\s+for|opening\\s+for|position[s]?\\s+for|requirement\\s+for)\\s+"
            + "(?:a|an|\\d+)?\\s*([A-Za-z][A-Za-z0-9/+#.\\- ]{2,40}?)"
            + "\\s*(?:\\.|,|!|\\n|with|at|in|who|having|-|–|\\()",
            Pattern.CASE_INSENSITIVE);

    /**
     * Classify a post.
     *
     * @param postText the visible text of the post
     */
    public static Signal judge(String postText) {
        String t = postText == null ? "" : postText.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
        if (t.length() < 60) return new Signal(Band.CLEAR_NOT, 0, "", "too short to be a posting");

        int seeking = count(SEEKING, t);
        int hiring = count(HIRING, t);
        int notHiring = count(NOT_HIRING, t);

        // A jobseeker's post outranks everything. It contains the same vocabulary as a hiring
        // post and contacting the author is worse than useless.
        if (seeking > 0 && seeking >= hiring) {
            return new Signal(Band.CLEAR_NOT, 90, "", "the author is looking for work, not offering it");
        }

        // Two independent hiring phrases is a recruiter telling you to act, not a coincidence.
        if (hiring >= 2) {
            return new Signal(Band.CLEAR_HIRING, Math.min(95, 70 + 8 * hiring), role(postText),
                    "states an opening and how to respond");
        }

        // One signal alongside an obvious not-hiring frame (a congratulations post that happens
        // to say "opportunities") is not an opening.
        if (hiring == 1 && notHiring == 0) {
            return new Signal(Band.AMBIGUOUS, 0, role(postText), "one hiring phrase — needs judgement");
        }
        if (hiring == 0 && notHiring > 0) {
            return new Signal(Band.CLEAR_NOT, 85, "", "not about a vacancy");
        }
        if (hiring == 0) {
            return new Signal(Band.CLEAR_NOT, 75, "", "no hiring language at all");
        }
        return new Signal(Band.AMBIGUOUS, 0, role(postText), "mixed signals");
    }

    /** Best effort at the role from plain phrasing; the model fills this in when we cannot. */
    static String role(String original) {
        if (original == null) return "";
        Matcher m = ROLE.matcher(original.replaceAll("\\s+", " "));
        if (!m.find()) return "";
        String r = m.group(1).trim();
        // Guard against swallowing half a sentence when the punctuation is missing.
        if (r.length() < 3 || r.split(" ").length > 6) return "";
        // "We are hiring people who are passionate about…" yields "people", which is not a role
        // and would go straight into a message as one. A bare generic noun is no answer.
        if (GENERIC.contains(r.toLowerCase(Locale.ROOT))) return "";
        return r;
    }
}
