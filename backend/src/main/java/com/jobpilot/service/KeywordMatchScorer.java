package com.jobpilot.service;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Experience-aware scorer (0..100), tuned for an early-career candidate:
 *   - skill overlap            (up to 45)
 *   - experience/seniority fit (up to 30)  — rewards fresher/junior, penalises senior
 *   - location/region fit      (up to 15)  — boosts India + remote
 *   - recency                  (up to 10)
 *
 * Reads the candidate's max years from profile.yearsExperience (default fresher)
 * and compares against the role's title + any "N+ years" requirement in the text.
 */
@Component
public class KeywordMatchScorer implements MatchScorer {

    private final NormalizeService normalize;

    public KeywordMatchScorer(NormalizeService normalize) {
        this.normalize = normalize;
    }

    private static final Pattern YEARS =
            Pattern.compile("(\\d{1,2})\\s*\\+?\\s*(?:-\\s*\\d{1,2}\\s*)?(?:years|yrs|yr)");

    private static final String[] SENIOR = {
            "senior", "sr.", "sr ", "lead", "principal", "staff", "architect",
            "manager", "director", "head of", "vp ", "vice president", "expert"
    };
    private static final String[] JUNIOR = {
            "intern", "internship", "junior", "jr.", "entry level", "entry-level",
            "graduate", "new grad", "trainee", "associate", "fresher", "early career", "apprentice"
    };

    @Override
    public int score(Job job, Profile profile) {
        if (profile == null) return 0;
        String title = job.getTitle() == null ? "" : job.getTitle().toLowerCase(Locale.ROOT);
        String desc = job.getDescription() == null ? "" : job.getDescription().toLowerCase(Locale.ROOT);

        int skills = scoreSkills(title, desc, profile.getSkills());
        int exp = scoreExperience(title, title + " " + desc, candidateYears(profile));
        int region = scoreRegion(normalize.region(job.getLocation(), job.isRemote()));
        int recency = scoreRecency(job.getPostedAt());

        return clamp(skills + exp + region + recency);
    }

    private double candidateYears(Profile p) {
        // Parse profile.yearsExperience ("0.9", "11 months" → ~1). Default fresher (0).
        String y = p.getYearsExperience();
        String sen = p.getSeniority() == null ? "" : p.getSeniority().toLowerCase(Locale.ROOT);
        if (y != null && !y.isBlank()) {
            Matcher m = Pattern.compile("(\\d+(?:\\.\\d+)?)").matcher(y);
            if (m.find()) {
                double v = Double.parseDouble(m.group(1));
                if (y.toLowerCase(Locale.ROOT).contains("month")) v = v / 12.0;
                return v;
            }
        }
        if (sen.equals("senior")) return 6;
        if (sen.equals("mid")) return 3;
        return 0.5; // entry/fresher default
    }

    /**
     * Skill-name synonym groups: a profile skill matches the job text if ANY spelling
     * in its group appears. Keeps "java" from matching "javascript" (word-boundary
     * matching below) while still catching "js" vs "javascript", "postgres" vs
     * "postgresql", "k8s" vs "kubernetes" and so on.
     */
    private static final String[][] SKILL_SYNONYMS = {
            {"javascript", "js", "ecmascript"},
            {"typescript", "ts"},
            {"python", "py"},
            {"golang", "go"},
            {"kubernetes", "k8s"},
            {"postgres", "postgresql"},
            {"react", "reactjs", "react.js"},
            {"node", "nodejs", "node.js"},
            {"vue", "vuejs", "vue.js"},
            {"angular", "angularjs"},
            {"next", "nextjs", "next.js"},
            {"express", "expressjs", "express.js"},
            {"spring", "spring boot", "springboot"},
            {"c#", "csharp", ".net", "dotnet"},
            {"c++", "cpp"},
            {"machine learning", "ml"},
            {"artificial intelligence", "ai"},
            {"amazon web services", "aws"},
            {"google cloud", "gcp", "google cloud platform"},
            {"mongodb", "mongo"},
            {"mysql", "sql"},
            {"html", "html5"},
            {"css", "css3"},
            {"rest", "rest api", "restful"},
            {"ci/cd", "cicd", "continuous integration"},
    };

    /**
     * Skill overlap, up to 45. Word-boundary matching (so "java" ≠ "javascript",
     * "r" doesn't match everything) with synonym expansion, and a skill found in the
     * TITLE counts extra — a title mention means it's the role's core requirement.
     */
    private int scoreSkills(String title, String desc, List<String> skills) {
        if (skills == null || skills.isEmpty()) return 0;
        double matched = 0;
        int considered = 0;
        for (String s : skills) {
            if (s == null || s.isBlank()) continue;
            considered++;
            String skill = s.toLowerCase(Locale.ROOT).trim();
            if (containsSkill(title, skill)) matched += 1.5;      // core requirement
            else if (containsSkill(desc, skill)) matched += 1.0;  // mentioned in JD
        }
        if (considered == 0) return 0;
        double ratio = Math.min(1.0, matched / considered);
        double absolute = Math.min(matched, 6) / 6.0;
        return (int) Math.round((ratio * 0.5 + absolute * 0.5) * 45);
    }

    /** True if the text contains the skill (or any synonym) as a whole word. */
    private boolean containsSkill(String hay, String skill) {
        if (hay.isEmpty()) return false;
        for (String variant : expand(skill)) {
            if (wordMatch(hay, variant)) return true;
        }
        return false;
    }

    private List<String> expand(String skill) {
        for (String[] group : SKILL_SYNONYMS) {
            for (String g : group) {
                if (g.equals(skill)) return List.of(group);
            }
        }
        return List.of(skill);
    }

    /**
     * Whole-word containment that tolerates skills with symbols ("c++", ".net",
     * "node.js"): the char before/after the match must not be a letter or digit,
     * and the char after must also not extend the token (stops "java|script").
     */
    private boolean wordMatch(String hay, String needle) {
        int from = 0, idx;
        while ((idx = hay.indexOf(needle, from)) >= 0) {
            char before = idx == 0 ? ' ' : hay.charAt(idx - 1);
            int endPos = idx + needle.length();
            char after = endPos >= hay.length() ? ' ' : hay.charAt(endPos);
            if (!Character.isLetterOrDigit(before) && !Character.isLetterOrDigit(after)) return true;
            from = idx + 1;
        }
        return false;
    }

    /** Reward roles within the candidate's reach; penalise senior roles and high year requirements. */
    private int scoreExperience(String title, String hay, double candidateYears) {
        boolean titleSenior = containsAny(title, SENIOR);
        boolean titleJunior = containsAny(title, JUNIOR);

        int base = 18; // neutral
        if (titleJunior) base = 30;
        if (titleSenior) base = candidateYears >= 5 ? 22 : 3; // big penalty for a fresher

        // Required years from the description.
        int required = maxYears(hay);
        if (required >= 0) {
            double gap = required - candidateYears;
            if (gap <= 1) base += 0;            // within reach
            else if (gap <= 3) base -= 8;       // a stretch
            else base = Math.min(base, 4);      // far out of reach (e.g. 5+/8+ yrs)
        }
        return Math.max(0, Math.min(30, base));
    }

    private int maxYears(String hay) {
        int max = -1;
        Matcher m = YEARS.matcher(hay);
        while (m.find()) {
            try { max = Math.max(max, Integer.parseInt(m.group(1))); } catch (NumberFormatException ignored) {}
        }
        return max;
    }

    private int scoreRegion(String region) {
        return switch (region) {
            case "india" -> 15;
            case "remote" -> 11;
            case "unknown" -> 6;
            default -> 2; // outside — least relevant for an India-based fresher
        };
    }

    private int scoreRecency(Instant postedAt) {
        if (postedAt == null) return 5;
        long days = Duration.between(postedAt, Instant.now()).toDays();
        if (days <= 3) return 10;
        if (days <= 7) return 8;
        if (days <= 14) return 5;
        if (days <= 30) return 2;
        return 0;
    }

    private boolean containsAny(String s, String[] needles) {
        for (String n : needles) if (s.contains(n)) return true;
        return false;
    }

    private int clamp(int v) {
        return Math.max(0, Math.min(100, v));
    }
}
