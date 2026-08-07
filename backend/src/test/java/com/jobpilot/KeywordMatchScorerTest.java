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

    /**
     * THE regression: with a broad profile every job scored the same.
     *
     * A real run produced, line after line: "Full Stack Engineer — fit 43", "Game Developer —
     * fit 43", "Three.Js Developer — fit 43", "Software Engineer — fit 43". A gate that gives a
     * Java backend role and a game role the same number is not judging anything, and with
     * fitMin 50 it meant nothing could ever be applied to.
     *
     * The cause was normalising the match count against EVERY skill on the profile, so listing
     * more skills lowered every score. These tests fix the behaviour in place: a matching job
     * must beat a non-matching one, and it must do so by a margin that survives a long skill
     * list — because the owner's profile has one.
     */
    @Test
    void aMatchingRoleOutscoresAnUnrelatedOneEvenWithALongSkillList() {
        Profile p = new Profile();
        p.setYearsExperience("1");
        // Deliberately broad — this is what a real profile looks like, and it is exactly the
        // shape that used to flatten every score to a constant.
        p.setSkills(List.of("java", "spring boot", "react", "typescript", "postgresql", "redis",
                "docker", "kubernetes", "aws", "git", "rest", "sql", "html", "css",
                "javascript", "node.js", "linux", "maven", "junit", "jira"));

        Job java = new Job();
        java.setTitle("Java Backend Developer");
        java.setDescription("Build REST APIs with Java and Spring Boot. PostgreSQL, Redis, "
                + "Docker and Kubernetes. Strong SQL fundamentals required.");
        java.setLocation("Bengaluru");

        Job game = new Job();
        game.setTitle("Three.Js Developer");
        game.setDescription("Build 3D game experiences with Three.js, WebGL and Blender. "
                + "Shader authoring and real-time rendering pipelines.");
        game.setLocation("Bengaluru");

        int jScore = scorer.score(java, p);
        int gScore = scorer.score(game, p);

        assertTrue(jScore > gScore + 10,
                "a Java role must clearly outscore a Three.js role — got java=" + jScore
                        + " game=" + gScore + " (they were both 43 before)");
        assertTrue(jScore >= 50,
                "a strong match must clear the default fitMin of 50, got " + jScore);
    }

    @Test
    void listingMoreSkillsNeverLowersAScore() {
        // The dilution, stated directly. The same job, the same matching skills, judged against
        // a short profile and a long one — adding skills you happen to have must not make you a
        // worse candidate for a job that wants the ones you already listed.
        Job j = new Job();
        j.setTitle("Java Backend Developer");
        j.setDescription("Java, Spring Boot and PostgreSQL. REST APIs at scale.");
        j.setLocation("Bengaluru");

        Profile few = new Profile();
        few.setYearsExperience("1");
        few.setSkills(List.of("java", "spring boot", "postgresql"));

        Profile many = new Profile();
        many.setYearsExperience("1");
        many.setSkills(List.of("java", "spring boot", "postgresql", "react", "typescript",
                "docker", "kubernetes", "aws", "redis", "kafka", "terraform", "go",
                "rust", "swift", "kotlin", "scala", "php", "ruby", "perl", "cobol"));

        assertTrue(scorer.score(j, many) >= scorer.score(j, few),
                "a longer skill list must not reduce the score: few=" + scorer.score(j, few)
                        + " many=" + scorer.score(j, many));
    }
}
