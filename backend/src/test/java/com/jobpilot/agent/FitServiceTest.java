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

    private static String longJd() { return "Responsibilities. ".repeat(30); }

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
    void aGenuineMatchPassesThrough() {
        aiReplies("{\"score\":88,\"techMatch\":true,\"confidence\":85,\"matched\":[\"Java\",\"React\"],\"reason\":\"strong overlap\"}");
        Map<String, Object> v = fit.jobFit("Java Full Stack Developer", "X", "Bengaluru", longJd());
        assertEquals(88, v.get("score"));
        assertEquals(true, v.get("techMatch"));
        assertEquals("ai", v.get("source"));
        assertEquals(List.of("Java", "React"), v.get("matched"));
    }

    @Test
    void aThinDescriptionIsNotJudgedByTheModelAtAll() {
        Map<String, Object> v = fit.jobFit("Developer", "X", "Bengaluru", "short");
        assertEquals("keyword", v.get("source"));
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void unreadableAiReplyFallsBackInsteadOfThrowing() {
        aiReplies("I'm sorry, I can't help with that.");
        Map<String, Object> v = fit.jobFit("Java Developer", "X", "Bengaluru", longJd());
        assertEquals("keyword", v.get("source"));
        assertNotNull(v.get("score"));
    }

    @Test
    void aiFailureFallsBackInsteadOfThrowing() {
        when(ai.complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any()))
                .thenThrow(new RuntimeException("provider down"));
        Map<String, Object> v = fit.jobFit("Java Developer", "X", "Bengaluru", longJd());
        assertEquals("keyword", v.get("source"));
    }

    @Test
    void scoresAreClampedToTheValidRange() {
        aiReplies("{\"score\":999,\"techMatch\":true,\"confidence\":-40}");
        Map<String, Object> v = fit.jobFit("Java Developer", "X", "Bengaluru", longJd());
        assertEquals(100, v.get("score"));
        assertEquals(0, v.get("confidence"));
    }

    @Test
    void theSameJobIsJudgedOnceAndCached() {
        aiReplies("{\"score\":80,\"techMatch\":true,\"confidence\":80}");
        fit.jobFit("Java Developer", "X", "Bengaluru", longJd());
        fit.jobFit("Java Developer", "X", "Bengaluru", longJd());
        // Determinism AND cost: the same posting must not be re-judged.
        verify(ai, times(1)).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void jsonWrappedInProseOrFencesIsStillParsed() {
        aiReplies("Sure!\n```json\n{\"score\":81,\"techMatch\":true,\"confidence\":70}\n```\nHope that helps.");
        Map<String, Object> v = fit.jobFit("Java Developer", "X", "Bengaluru", longJd());
        assertEquals(81, v.get("score"));
        assertEquals("ai", v.get("source"));
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
        Map<String, Object> v = fit.jobFit("Java Developer", "X", "Bengaluru", longJd());
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

        Map<String, Object> v = fit.jobFit("Java Developer", "Acme", "Bengaluru", longJd());

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
        Map<String, Object> v = fit.jobFit("Java Developer", "Acme", "Bengaluru", longJd());
        assertEquals("no_profile", v.get("source"));
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    @Test
    void aPopulatedProfileStillReachesTheAi() {
        aiReplies("{\"score\":88,\"techMatch\":true,\"confidence\":90,\"matched\":[\"Java\"],"
                + "\"missing\":[],\"reason\":\"strong match\"}");
        Map<String, Object> v = fit.jobFit("Java Developer", "Acme", "Bengaluru", longJd());
        assertEquals("ai", v.get("source"), "the guard must not swallow real evaluations");
        assertEquals(88, v.get("score"));
    }
}
