package com.jobpilot.agent;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The three-band gate. These cases are taken from a REAL run's verdicts, so the rules are
 * pinned against the jobs that actually came back — not against invented ones.
 *
 * The asymmetry that matters: a wrong CLEAR_NO throws away a job the owner could have had, and
 * nobody ever finds out. A wrong CLEAR_YES costs one wasted application. So when in doubt the
 * answer must be AMBIGUOUS and the model decides — never a confident rejection.
 */
class DeterministicFitTest {

    private static final List<String> MINE =
            List.of("Java", "Spring Boot", "React", "Node.js", "MongoDB", "JavaScript", "SQL", "Git");

    private static String jd(String body) {
        // Long enough to clear the "too thin to judge" floor, as a real posting would be.
        return body + " ".repeat(1) + "You will work in a small team, take part in code reviews, "
                + "and own features end to end. We value clear communication and ownership. "
                + "Competitive salary, hybrid working from our Bengaluru office.";
    }

    // ---- CLEAR NO: a different stack entirely -----------------------------------

    @Test
    void aPythonRoleIsRejectedWithoutTheModel() {
        var v = DeterministicFit.judge(MINE, "Python Developer",
                jd("We need strong Python with Django and Flask. You will build ETL pipelines."));
        assertEquals(DeterministicFit.Band.CLEAR_NO, v.band());
        assertFalse(v.techMatch());
        assertTrue(v.reason().contains("Python"), v.reason());
    }

    @Test
    void otherStacksAreRejectedToo() {
        record C(String title, String body) { }
        for (C c : List.of(
                new C("Flutter Developer", "Flutter and Dart for cross-platform mobile apps."),
                new C(".NET Full Stack Developer", "C# with .NET Core and Angular on the front end."),
                new C("RPG developer", "RPGLE and COBOL on IBM i, maintaining legacy modules."),
                new C("Salesforce Developer", "Salesforce Apex and Lightning Web Components."),
                new C("iOS Developer", "Swift and SwiftUI, Objective-C for the older screens."))) {
            var v = DeterministicFit.judge(MINE, c.title(), jd(c.body()));
            assertEquals(DeterministicFit.Band.CLEAR_NO, v.band(), c.title() + " -> " + v.reason());
        }
    }

    @Test
    void seniorityIsDecidedFromTheTitleAlone() {
        for (String t : List.of("Senior Backend Engineer", "Staff Software Engineer",
                "Principal AI Compiler Engineer", "Lead Full-Stack Engineer", "Engineering Manager")) {
            var v = DeterministicFit.judge(MINE, t, jd("Java, Spring Boot and React throughout."));
            assertEquals(DeterministicFit.Band.CLEAR_NO, v.band(), t);
            assertEquals("senior/leadership role", v.reason());
        }
    }

    @Test
    void workingWithSeniorEngineersIsNotASeniorRole() {
        // The BODY says senior; the title does not. This must not be rejected.
        var v = DeterministicFit.judge(MINE, "Backend Developer",
                jd("You will work alongside senior engineers on our Java and Spring Boot services, "
                   + "with React on the front end."));
        assertEquals(DeterministicFit.Band.CLEAR_YES, v.band(), v.reason());
    }

    // ---- CLEAR YES: the candidate's own stack -----------------------------------

    @Test
    void aJavaSpringRoleIsAcceptedWithoutTheModel() {
        var v = DeterministicFit.judge(MINE, "Backend Developer",
                jd("Java and Spring Boot microservices, REST APIs, SQL. React knowledge a plus."));
        assertEquals(DeterministicFit.Band.CLEAR_YES, v.band(), v.reason());
        assertTrue(v.techMatch());
        assertTrue(v.score() >= 75, "a clean match should score well, got " + v.score());
    }

    @Test
    void aMernRoleIsAccepted() {
        var v = DeterministicFit.judge(MINE, "Full Stack Developer",
                jd("React on the front end, Node.js and Express on the back, MongoDB for storage."));
        assertEquals(DeterministicFit.Band.CLEAR_YES, v.band(), v.reason());
    }

    @Test
    void aFrameworkImpliesItsLanguage() {
        // The posting never says "Java" — only Spring. It still requires Java.
        var v = DeterministicFit.judge(List.of("Java", "Spring Boot", "SQL"), "Backend Developer",
                jd("Spring Boot services backed by PostgreSQL, with Hibernate for persistence."));
        assertEquals(DeterministicFit.Band.CLEAR_YES, v.band(), v.reason());
    }

    @Test
    void spellingsOfOneTechnologyAreTheSameThing() {
        for (String spelling : List.of("Node.js", "NodeJS", "node js")) {
            var v = DeterministicFit.judge(List.of("JavaScript", "Node.js", "React"), "Developer",
                    jd(spelling + " and React are the core of our stack, with Express for routing."));
            assertEquals(DeterministicFit.Band.CLEAR_YES, v.band(), spelling + " -> " + v.reason());
        }
    }

    // ---- AMBIGUOUS: hand it to the model ---------------------------------------

    @Test
    void oneSharedTechnologyIsNotEnoughToAccept() {
        // Every backend job mentions SQL. One overlap is not a stack.
        var v = DeterministicFit.judge(MINE, "Data Engineer",
                jd("Build pipelines with Apache Spark and Hadoop. Strong SQL required, Scala preferred."));
        assertNotEquals(DeterministicFit.Band.CLEAR_YES, v.band(), v.reason());
    }

    @Test
    void aPartialOverlapGoesToTheModel() {
        var v = DeterministicFit.judge(MINE, "Full Stack Engineer",
                jd("React on the front end, Python and FastAPI on the back end, Postgres for data."));
        assertEquals(DeterministicFit.Band.AMBIGUOUS, v.band(), v.reason());
    }

    @Test
    void aVagueDescriptionGoesToTheModelRatherThanBeingGuessed() {
        var v = DeterministicFit.judge(MINE, "Software Engineer",
                "We are hiring a software engineer. Apply now! Great team, great culture.");
        assertEquals(DeterministicFit.Band.AMBIGUOUS, v.band(), v.reason());
    }

    @Test
    void anEmptyProfileNeverProducesAConfidentRejection() {
        // With nothing to compare against, a CLEAR_NO would reject the entire job market.
        var v = DeterministicFit.judge(List.of(), "Backend Developer",
                jd("Java and Spring Boot microservices with React."));
        assertEquals(DeterministicFit.Band.AMBIGUOUS, v.band(), v.reason());
    }

    @Test
    void nullsAndBlanksAreToleratedAndNeverRejectConfidently() {
        assertEquals(DeterministicFit.Band.AMBIGUOUS,
                DeterministicFit.judge(MINE, null, null).band());
        assertEquals(DeterministicFit.Band.AMBIGUOUS,
                DeterministicFit.judge(null, "Developer", jd("Java and Spring.")).band());
        assertEquals(DeterministicFit.Band.AMBIGUOUS,
                DeterministicFit.judge(MINE, "Developer", "").band());
    }

    // ---- the taxonomy itself ----------------------------------------------------

    @Test
    void punctuatedNamesAreMatched() {
        // \b would refuse to match "c++" at all, so a C++ job would read as having no stack.
        assertTrue(TechTaxonomy.extract("Strong C++ required").contains("cpp"));
        assertTrue(TechTaxonomy.extract("ASP.NET MVC and C#").contains("csharp"));
        assertTrue(TechTaxonomy.extract("Node.js backend").contains("node"));
    }

    @Test
    void aTechnologyIsNotMatchedInsideAnotherWord() {
        // "javascript" must not register as "java" — that single mistake would flip a
        // front-end-only role into a Java match.
        var only = TechTaxonomy.extract("Modern JavaScript and TypeScript, no backend work");
        assertFalse(only.contains("java"), "JavaScript must not count as Java: " + only);
        assertTrue(only.contains("javascript"));
    }

    @Test
    void infrastructureNeverDisqualifiesOnItsOwn() {
        // Missing Docker or Kafka is a week of learning, not a different job.
        var v = DeterministicFit.judge(MINE, "Backend Developer",
                jd("Java, Spring Boot and React. We deploy with Docker and Kubernetes, and use Kafka."));
        assertEquals(DeterministicFit.Band.CLEAR_YES, v.band(), v.reason());
    }
}
