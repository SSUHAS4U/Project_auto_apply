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
 * Defence in depth for the one action that reaches a stranger.
 *
 * Contacting someone is the only thing this system does that cannot be undone and that a third
 * party experiences. Until now the post classifier was the ONLY check on the message route —
 * scanHiringPosts called upsertContact directly — so a single misjudgement was a single wrong
 * message to a real person.
 *
 * There are now two INDEPENDENT layers, and these tests exist to prove neither is load-bearing
 * on its own:
 *
 *   1. PostSignals   — is this post announcing a job?      (the post's words)
 *   2. recruiterFit  — is this author someone who hires?   (their headline + their posts)
 *
 * Different evidence, so one being wrong is survivable. A post can read as hiring while its
 * author's own headline says "Open to work".
 */
class ContactWallsTest {

    private AiService ai;
    private FitService fit;

    @BeforeEach
    void setUp() {
        ai = Mockito.mock(AiService.class);
        ProfileService profiles = Mockito.mock(ProfileService.class);
        KeywordMatchScorer scorer = Mockito.mock(KeywordMatchScorer.class);
        when(ai.isEnabled()).thenReturn(true);
        when(scorer.score(any(), any())).thenReturn(30);
        Profile p = new Profile();
        p.setSkills(List.of("Java", "Spring Boot", "React"));
        when(profiles.get()).thenReturn(p);
        fit = new FitService(ai, profiles, scorer);
    }

    /** The model saying yes to everything — so only the deterministic walls can stop a send. */
    private void modelSaysYesToEverything() {
        when(ai.complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any()))
                .thenReturn("{\"isRecruiter\":true,\"hiringNow\":true,\"confidence\":99,"
                          + "\"topic\":\"hiring\",\"isHiring\":true,\"role\":\"Engineer\"}");
    }

    private static final String SEEKER_POST =
            "Open to work! I am a Java developer with 3 years of experience, immediate joiner, "
            + "notice period 0 days. Please share your resume referrals — any leads would be "
            + "appreciated. I am actively looking for a new role in Bengaluru.";

    // ---- LAYER 1: the post -------------------------------------------------------

    @Test
    void layerOneRejectsAJobseekersPostEvenThoughItUsesHiringVocabulary() {
        // "share your resume", "immediate joiner", "notice period" are all hiring phrases.
        var s = PostSignals.judge(SEEKER_POST);
        assertEquals(PostSignals.Band.CLEAR_NOT, s.band(), s.reason());
    }

    @Test
    void layerOneHoldsWithTheModelAnsweringYesToEverything() {
        modelSaysYesToEverything();
        Map<String, Object> r = fit.postIntent(SEEKER_POST);
        assertEquals(false, r.get("isHiring"), "a seeker's post must not be a hiring post");
        assertEquals("rules", r.get("source"), "and it must not have cost a model call");
        verify(ai, never()).complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any());
    }

    // ---- LAYER 2: the person -----------------------------------------------------

    @Test
    void layerTwoRejectsTheAuthorEvenIfLayerOneLetThePostThrough() {
        // Assume the worst: the post classifier was wrong. The author's own headline still says
        // what they are, and that is separate evidence.
        modelSaysYesToEverything();
        for (String headline : List.of(
                "Open to work | Java Developer",
                "Aspiring Software Engineer",
                "Fresher seeking opportunities",
                "Student at NIT Trichy")) {
            Map<String, Object> v = fit.recruiterFit("Someone", headline, List.of(SEEKER_POST));
            assertEquals(false, v.get("contact"), headline + " must never be contacted");
        }
    }

    @Test
    void layerTwoAlsoRejectsPeopleWhoSimplyDoNotHire() {
        modelSaysYesToEverything();
        for (String headline : List.of(
                "Sales Manager at Acme",
                "Business Development Executive",
                "Full Stack Developer at Y")) {
            assertEquals(false, fit.recruiterFit("X", headline, List.of()).get("contact"), headline);
        }
    }

    // ---- both layers must agree before anyone is contacted -----------------------

    @Test
    void aGenuineRecruiterPassesBothLayers() {
        // The walls must not be so tight that nothing gets through — that is its own failure,
        // and an outreach flow that contacts nobody is indistinguishable from a broken one.
        var s = PostSignals.judge(
                "We are hiring backend engineers for our Bengaluru team. Share your resume at "
                + "careers@acme.com and our recruiters will get back to you this week.");
        assertEquals(PostSignals.Band.CLEAR_HIRING, s.band(), s.reason());

        Map<String, Object> v = fit.recruiterFit("Priya", "Technical Recruiter at Acme", List.of());
        assertEquals(true, v.get("contact"));
        assertEquals("title", v.get("source"), "an obvious recruiter should not cost a model call");
    }

    @Test
    void noEvidenceMeansNoContact() {
        // Fail closed. An ordinary engineer with nothing to go on is not a hiring contact, and
        // "we could not tell" must never resolve to "send it".
        when(ai.complete(anyString(), anyString(), anyBoolean(), anyBoolean(), any()))
                .thenThrow(new RuntimeException("provider down"));
        Map<String, Object> v = fit.recruiterFit("B", "Engineering Manager at Q",
                List.of("Great conference talk today."));
        assertEquals(false, v.get("contact"), "an unavailable evaluator must not approve a send");
    }
}
