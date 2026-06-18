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
    private static final String[] INDIA = {
            "india", "bengaluru", "bangalore", "hyderabad", "pune", "chennai", "mumbai",
            "delhi", "gurgaon", "gurugram", "noida", "kolkata", "ahmedabad", "remote - india", "remote india"
    };

    @Override
    public int score(Job job, Profile profile) {
        if (profile == null) return 0;
        String title = job.getTitle() == null ? "" : job.getTitle().toLowerCase(Locale.ROOT);
        String desc = job.getDescription() == null ? "" : job.getDescription().toLowerCase(Locale.ROOT);
        String loc = job.getLocation() == null ? "" : job.getLocation().toLowerCase(Locale.ROOT);
        String hay = title + " " + desc;

        int skills = scoreSkills(hay, profile.getSkills());
        int exp = scoreExperience(title, hay, candidateYears(profile));
        int region = scoreRegion(loc, job.isRemote());
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

    private int scoreSkills(String hay, List<String> skills) {
        if (skills == null || skills.isEmpty()) return 0;
        int matched = 0;
        for (String s : skills) {
            if (s != null && !s.isBlank() && hay.contains(s.toLowerCase(Locale.ROOT).trim())) matched++;
        }
        double ratio = (double) matched / skills.size();
        double absolute = Math.min(matched, 6) / 6.0;
        return (int) Math.round((ratio * 0.5 + absolute * 0.5) * 45);
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

    private int scoreRegion(String loc, boolean remote) {
        if (containsAny(loc, INDIA)) return 15;
        if (remote || loc.contains("remote") || loc.contains("anywhere")) return 11;
        if (loc.isBlank()) return 6;
        return 2; // foreign on-site — least relevant for an India-based fresher
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
