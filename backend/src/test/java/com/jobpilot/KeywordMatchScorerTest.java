package com.jobpilot;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.KeywordMatchScorer;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class KeywordMatchScorerTest {

    private final KeywordMatchScorer scorer =
            new KeywordMatchScorer(new com.jobpilot.service.NormalizeService());

    private Profile profile() {
        Profile p = new Profile();
        p.setFullName("Test");
        p.setSeniority("mid");
        p.setSkills(List.of("java", "spring", "postgres", "react"));
        return p;
    }

    @Test
    void strongOverlapScoresHigherThanNoOverlap() {
        Job good = new Job();
        good.setTitle("Java Backend Engineer");
        good.setDescription("We use Java, Spring Boot and Postgres heavily.");
        good.setPostedAt(Instant.now());

        Job bad = new Job();
        bad.setTitle("Sales Associate");
        bad.setDescription("Cold calling and CRM data entry.");
        bad.setPostedAt(Instant.now());

        int g = scorer.score(good, profile());
        int b = scorer.score(bad, profile());
        assertTrue(g > b, "relevant job should outscore irrelevant one (" + g + " vs " + b + ")");
        assertTrue(g >= 40, "strong match should be reasonably high, was " + g);
    }

    @Test
    void scoreIsBounded() {
        Job j = new Job();
        j.setTitle("Java Spring Postgres React Developer");
        j.setDescription("java spring postgres react ".repeat(20));
        j.setPostedAt(Instant.now());
        int s = scorer.score(j, profile());
        assertTrue(s >= 0 && s <= 100, "score in [0,100], was " + s);
    }

    @Test
    void skillMatchingUsesWordBoundaries() {
        // A "java" skill must NOT match a JavaScript-only job.
        Profile p = new Profile();
        p.setSeniority("mid");
        p.setSkills(List.of("java"));

        Job jsOnly = new Job();
        jsOnly.setTitle("Frontend Engineer");
        jsOnly.setDescription("You will write javascript and typescript all day.");
        jsOnly.setPostedAt(Instant.now());

        Job javaJob = new Job();
        javaJob.setTitle("Frontend Engineer");
        javaJob.setDescription("You will write java services all day.");
        javaJob.setPostedAt(Instant.now());

        assertTrue(scorer.score(javaJob, p) > scorer.score(jsOnly, p),
                "'java' skill must not match 'javascript' text");
    }

    @Test
    void skillSynonymsMatch() {
        // Profile says "javascript"; the JD only says "JS" — should still count.
        Profile p = new Profile();
        p.setSeniority("mid");
        p.setSkills(List.of("javascript"));

        Job jsJob = new Job();
        jsJob.setTitle("Web Developer");
        jsJob.setDescription("Strong JS and HTML required.");
        jsJob.setPostedAt(Instant.now());

        Job noneJob = new Job();
        noneJob.setTitle("Web Developer");
        noneJob.setDescription("Strong COBOL required.");
        noneJob.setPostedAt(Instant.now());

        assertTrue(scorer.score(jsJob, p) > scorer.score(noneJob, p),
                "synonym 'js' should match a 'javascript' skill");
    }

    @Test
    void titleSkillOutweighsDescriptionSkill() {
        Profile p = new Profile();
        p.setSeniority("mid");
        p.setSkills(List.of("java"));

        Job inTitle = new Job();
        inTitle.setTitle("Java Developer");
        inTitle.setDescription("Great team.");
        inTitle.setPostedAt(Instant.now());

        Job inDesc = new Job();
        inDesc.setTitle("Software Developer");
        inDesc.setDescription("Some java exposure is a plus.");
        inDesc.setPostedAt(Instant.now());

        assertTrue(scorer.score(inTitle, p) >= scorer.score(inDesc, p),
                "a skill in the title is a core requirement and should score at least as high");
    }

    @Test
    void recencyBoostsScore() {
        Job fresh = new Job();
        fresh.setTitle("Java Engineer");
        fresh.setDescription("java spring");
        fresh.setPostedAt(Instant.now());

        Job old = new Job();
        old.setTitle("Java Engineer");
        old.setDescription("java spring");
        old.setPostedAt(Instant.now().minusSeconds(60L * 60 * 24 * 90));

        assertTrue(scorer.score(fresh, profile()) > scorer.score(old, profile()));
    }
}
