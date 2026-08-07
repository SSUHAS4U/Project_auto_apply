package com.jobpilot.agent;

import com.jobpilot.domain.Profile;
import com.jobpilot.service.KeywordMatchScorer;
import com.jobpilot.service.ProfileService;
import com.jobpilot.service.ai.AiService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * The judgement layer decides what gets applied to and who gets messaged, so the rules that
 * protect against the observed failures (a Python role reaching a Java résumé; twenty strangers
 * being invited) are pinned here rather than left to the model's goodwill.
 */
class FitServiceTest {

    private AiService ai;
    private ProfileService profiles;
    private FitService fit;

    @BeforeEach
    void setUp() {
        ai = Mockito.mock(AiService.class);
        profiles = Mockito.mock(ProfileService.class);
        KeywordMatchScorer scorer = Mockito.mock(KeywordMatchScorer.class);
        when(ai.isEnabled()).thenReturn(true);
        when(scorer.score(any(), any())).thenReturn(30);

        Profile p = new Profile();
        p.setFullName("S Suhas");
        p.setSkills(List.of("Java", "Spring Boot", "React", "Node.js", "MongoDB"));
        p.setYearsExperience("1");
        when(profiles.get()).thenReturn(p);

        fit = new FitService(ai, profiles, scorer);
    }

    private void aiReplies(String body) {
        when(ai.complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any())).thenReturn(body);
    }

    /**
     * A posting the RULES cannot settle, so these tests still exercise the AI path.
     *
     * The three-band gate now answers clear-cut jobs itself, which is the point of it — but it
     * means a fixture like "Responsibilities." x30 under the title "Java Developer" never
     * reaches the model at all. Partial overlap (React matches, Python/Django do not) is
     * exactly the band the model exists for.
     */
    private static String longJd() {
        return "You will build features with React on the front end and Python with Django on "
             + "the back end, working across the stack. ".repeat(4)
             + "Responsibilities include code review, testing and production support.";
    }

    /** Neutral title — a title naming a technology would let the rules decide on its own. */
    private static final String NEUTRAL = "Software Engineer";

    // ---- job fit ----------------------------------------------------------------

    @Test
    void techMismatchCapsTheScoreEvenIfTheModelSaysOtherwise() {
        // The model claiming 95 while admitting the stack doesn't match must not win.
        aiReplies("{\"score\":95,\"techMatch\":false,\"confidence\":90,\"reason\":\"title matches only\"}");
        Map<String, Object> v = fit.jobFit("Python Developer", "HARP", "Bengaluru", longJd());
        assertFalse((Boolean) v.get("techMatch"));
        assertTrue((Integer) v.get("score") <= 55,
                "a stack mismatch must be capped at 55, got " + v.get("score"));
    }

    @Test
    void aGenuineMatchPassesThroughWithoutAskingTheModel() {
        // Matching is a skills-overlap question and the taxonomy answers it. The model is not
        // consulted at all now — a rate limit must never be able to cost a verdict again.
        aiReplies("{\"score\":88,\"techMatch\":true,\"confidence\":85}");
        Map<String, Object> v = fit.jobFit(NEUTRAL, "X", "Bengaluru", longJd());
        assertEquals("rules", v.get("source"));
        assertNotNull(v.get("score"));
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void aThinDescriptionIsNotJudgedByTheModelAtAll() {
        Map<String, Object> v = fit.jobFit("Developer", "X", "Bengaluru", "short");
        assertEquals("keyword", v.get("source"));
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void aBrokenModelCannotAffectAVerdict() {
        // It could not even be asked, so whatever it would have said is irrelevant.
        aiReplies("I'm sorry, I can't help with that.");
        Map<String, Object> v = fit.jobFit(NEUTRAL, "X", "Bengaluru", longJd());
        assertEquals("rules", v.get("source"));
        assertNotNull(v.get("score"));
    }

    @Test
    void everyProviderBeingDownStillProducesAVerdict() {
        // THE regression this whole change exists to prevent. On a real run 30 of 38 jobs came
        // back "not evaluated (AI unavailable)" and joined a manual pile of 35 that nobody
        // reads. A job must always leave the gate with a number.
        when(ai.complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any()))
                .thenThrow(new RuntimeException("provider down"));
        Map<String, Object> v = fit.jobFit(NEUTRAL, "X", "Bengaluru", longJd());
        assertEquals("rules", v.get("source"));
        assertNotNull(v.get("score"), "a job must never leave the gate unjudged");
    }

    @Test
    void scoresAreClampedToTheValidRange() {
        Map<String, Object> v = fit.jobFit(NEUTRAL, "X", "Bengaluru", longJd());
        int score = (Integer) v.get("score");
        int conf = (Integer) v.get("confidence");
        assertTrue(score >= 0 && score <= 100, "score out of range: " + score);
        assertTrue(conf >= 0 && conf <= 100, "confidence out of range: " + conf);
    }

    @Test
    void theSameJobGetsTheSameVerdictEveryTime() {
        // Determinism was previously bought with a cache around a non-deterministic model.
        // Rules give it for free, which is a better guarantee: identical input, identical
        // output, no cache to go stale and no cost to re-running it.
        Map<String, Object> a = fit.jobFit(NEUTRAL, "X", "Bengaluru", longJd());
        Map<String, Object> b = fit.jobFit(NEUTRAL, "X", "Bengaluru", longJd());
        assertEquals(a.get("score"), b.get("score"));
        assertEquals(a.get("techMatch"), b.get("techMatch"));
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void matchingMakesNoNetworkCallAtAll() {
        // The point of the change, stated as a test: judging a job costs nothing and cannot be
        // rate limited. Four evaluate calls a minute were exhausting a quota that allows 15-30,
        // because the quota had already been spent elsewhere — now it does not matter.
        fit.jobFit(NEUTRAL, "X", "Bengaluru", longJd());
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void theCandidateSummaryCarriesTheSkillsTheModelMustJudgeOn() {
        String s = fit.candidateSummary();
        assertTrue(s.contains("Java"), s);
        assertTrue(s.contains("React"), s);
    }

    // ---- person fit --------------------------------------------------------------

    @Test
    void recruiterTitlesAreAcceptedWithoutSpendingAModelCall() {
        for (String h : List.of("Technical Recruiter at X", "Talent Acquisition Specialist",
                "HR Business Partner", "Senior Recruitment Consultant", "People Operations Lead")) {
            Map<String, Object> v = fit.recruiterFit("A", h, List.of());
            assertEquals(true, v.get("contact"), h);
            assertEquals("title", v.get("source"), h);
        }
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void ordinaryEngineersAreRejectedWithNoPostsToGoOn() {
        // Precisely the twenty people the last run messaged.
        Map<String, Object> v = fit.recruiterFit("B", "Full Stack Developer at Y", List.of());
        assertEquals(false, v.get("contact"));
    }

    @Test
    void jobSeekersAreRejectedOutright() {
        for (String h : List.of("Open to work | Aspiring Developer", "Student at NIT", "Fresher seeking opportunities")) {
            assertEquals(false, fit.recruiterFit("C", h, List.of()).get("contact"), h);
        }
    }

    @Test
    void salesAndMarketingAreNotHiringContacts() {
        assertEquals(false, fit.recruiterFit("D", "Sales Manager at Z", List.of()).get("contact"));
        assertEquals(false, fit.recruiterFit("E", "Business Development Executive", List.of()).get("contact"));
    }

    @Test
    void anAmbiguousHeadlineIsDecidedByTheirPosts() {
        aiReplies("{\"isRecruiter\":false,\"hiringNow\":true,\"confidence\":88,\"topic\":\"hiring 2 backend engineers\"}");
        Map<String, Object> v = fit.recruiterFit("F", "Engineering Manager at Q",
                List.of("We're hiring 2 backend engineers for my team — DM me."));
        assertEquals(true, v.get("contact"));
        assertEquals("hiring 2 backend engineers", v.get("topic"));
    }

    @Test
    void anAmbiguousHeadlineWithUnrelatedPostsIsRejected() {
        aiReplies("{\"isRecruiter\":false,\"hiringNow\":false,\"confidence\":85,\"topic\":\"\"}");
        Map<String, Object> v = fit.recruiterFit("G", "Engineering Manager at Q",
                List.of("Great conference talk on Kubernetes today."));
        assertEquals(false, v.get("contact"));
    }

    @Test
    void noHeadlineSignalAndNoPostsMeansNoContact() {
        Map<String, Object> v = fit.recruiterFit("H", "Engineering Manager at Q", List.of());
        assertEquals(false, v.get("contact"), "no evidence must mean no message");
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void aiDisabledNeverSilentlyApprovesAPerson() {
        when(ai.isEnabled()).thenReturn(false);
        Map<String, Object> v = fit.recruiterFit("I", "Engineering Manager", List.of("we are growing the team"));
        assertEquals(false, v.get("contact"));
    }

    @Test
    void aiDisabledStillScoresJobsByKeyword() {
        when(ai.isEnabled()).thenReturn(false);
        Map<String, Object> v = fit.jobFit(NEUTRAL, "X", "Bengaluru", longJd());
        assertEquals("keyword", v.get("source"));
        assertNotNull(v.get("score"));
    }

    @Test
    void nullsAreToleratedEverywhere() {
        assertDoesNotThrow(() -> fit.jobFit(null, null, null, null));
        assertDoesNotThrow(() -> fit.recruiterFit(null, null, null));
    }

    /**
     * An empty Profile must not be laundered into a verdict about the job.
     *
     * candidateSummary() returns a placeholder ("(profile is empty …)") when there is nothing
     * saved. That placeholder used to be sent to the model AS the candidate, which scored every
     * job 0 with techMatch=false and tagged it source="ai" — so the worker skipped a whole run
     * as "stack mismatch (fit 0)" and never mentioned the profile. The AI must not even be asked.
     */
    @Test
    void anEmptyProfileIsReportedAsSuchRatherThanAsAStackMismatch() {
        when(profiles.get()).thenReturn(new Profile());     // nothing filled in

        Map<String, Object> v = fit.jobFit(NEUTRAL, "Acme", "Bengaluru", longJd());

        assertEquals("no_profile", v.get("source"), "the cause must be identifiable by the caller");
        assertEquals(false, v.get("techMatch"));
        assertEquals(0, v.get("score"));
        assertTrue(String.valueOf(v.get("reason")).toLowerCase().contains("profile"),
                "the reason must name the profile: " + v.get("reason"));
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void anUnreadableProfileIsTreatedTheSameWayAsAnEmptyOne() {
        when(profiles.get()).thenThrow(new IllegalStateException("no user context"));
        Map<String, Object> v = fit.jobFit(NEUTRAL, "Acme", "Bengaluru", longJd());
        assertEquals("no_profile", v.get("source"));
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void aPopulatedProfileIsStillActuallyJudged() {
        // The pair to the test above: the no-profile guard must refuse a job it cannot judge,
        // but it must NOT swallow a job it can. With a real profile the verdict comes from the
        // rules and carries a score — not the "no_profile" refusal.
        Map<String, Object> v = fit.jobFit(NEUTRAL, "Acme", "Bengaluru", longJd());
        assertEquals("rules", v.get("source"), "the guard must not swallow real evaluations");
        assertNotNull(v.get("score"));
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }
}
