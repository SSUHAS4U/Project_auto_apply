package com.jobpilot.service;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Deterministic V1 scorer (0..100):
 *   - skill overlap vs. title+description (up to 70)
 *   - seniority fit (up to 15)
 *   - recency boost (up to 15)
 */
@Component
public class KeywordMatchScorer implements MatchScorer {

    @Override
    public int score(Job job, Profile profile) {
        if (profile == null) return 0;
        String haystack = ((job.getTitle() == null ? "" : job.getTitle()) + " "
                + (job.getDescription() == null ? "" : job.getDescription()))
                .toLowerCase(Locale.ROOT);

        int skillPoints = scoreSkills(haystack, profile.getSkills());
        int seniorityPoints = scoreSeniority(haystack, profile.getSeniority());
        int recencyPoints = scoreRecency(job.getPostedAt());

        return clamp(skillPoints + seniorityPoints + recencyPoints);
    }

    private int scoreSkills(String haystack, List<String> skills) {
        if (skills == null || skills.isEmpty()) return 0;
        int matched = 0;
        for (String s : skills) {
            if (s == null || s.isBlank()) continue;
            if (haystack.contains(s.toLowerCase(Locale.ROOT).trim())) matched++;
        }
        double ratio = (double) matched / skills.size();
        // Reward absolute matches too, so a profile with many skills still scores.
        double absoluteBoost = Math.min(matched, 6) / 6.0;
        return (int) Math.round((ratio * 0.6 + absoluteBoost * 0.4) * 70);
    }

    private int scoreSeniority(String haystack, String seniority) {
        if (seniority == null || seniority.isBlank()) return 8; // neutral
        String s = seniority.toLowerCase(Locale.ROOT);
        Set<String> entry = new HashSet<>(Arrays.asList("intern", "junior", "entry", "graduate", "trainee"));
        Set<String> senior = new HashSet<>(Arrays.asList("senior", "lead", "principal", "staff", "manager", "head"));
        boolean titleEntry = entry.stream().anyMatch(haystack::contains);
        boolean titleSenior = senior.stream().anyMatch(haystack::contains);
        boolean profEntry = entry.contains(s) || s.equals("mid");
        if (profEntry && titleSenior) return 2;   // mismatch
        if (!profEntry && titleEntry) return 5;    // overqualified-ish
        return 15;
    }

    private int scoreRecency(Instant postedAt) {
        if (postedAt == null) return 7;
        long days = Duration.between(postedAt, Instant.now()).toDays();
        if (days <= 2) return 15;
        if (days <= 7) return 11;
        if (days <= 14) return 7;
        if (days <= 30) return 3;
        return 0;
    }

    private int clamp(int v) {
        return Math.max(0, Math.min(100, v));
    }
}
