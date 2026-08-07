package com.jobpilot.agent;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Post classification without a model call.
 *
 * The asymmetry here is different from the fit gate's. A missed hiring post costs one lead. A
 * post wrongly classified as hiring gets a REAL PERSON contacted — and if that person was
 * actually asking for work themselves, the message is both useless and embarrassing. So the
 * seeking check outranks everything, and doubt goes to the model rather than to a send.
 */
class PostSignalsTest {

    private static final String PAD =
            " Our team is growing and we would love to hear from good people. Feel free to reach out.";

    @Test
    void aRecruiterPostIsRecognisedWithoutTheModel() {
        var s = PostSignals.judge(
                "We are hiring Java backend developers for our Bengaluru office. "
                + "Share your resume at careers@acme.com." + PAD);
        assertEquals(PostSignals.Band.CLEAR_HIRING, s.band(), s.reason());
        assertTrue(s.confidence() >= 70);
    }

    @Test
    void theCommonPhrasingsAreAllCovered() {
        for (String p : new String[] {
                "We're hiring! Open positions for backend engineers. DM me your CV." + PAD,
                "Now hiring: Full Stack Developer. Interested candidates please share your profile." + PAD,
                "Urgent requirement for Java developers. Notice period: immediate. CTC as per market." + PAD,
                "I am hiring 3 engineers for my team. Apply here: https://acme.example/jobs" + PAD,
                "Job opening for React Developer at our Pune office. Send your resume to hr@x.com." + PAD }) {
            assertEquals(PostSignals.Band.CLEAR_HIRING, PostSignals.judge(p).band(), p);
        }
    }

    // ---- the ones that must NEVER be contacted ---------------------------------

    @Test
    void aJobseekersPostIsNeverTreatedAsHiring() {
        // These contain the same vocabulary as a recruiter post. Messaging the author about a
        // vacancy they do not have is the worst outcome this classifier can produce.
        for (String p : new String[] {
                "Open to work! I am a Java developer with 3 years of experience. "
                + "Please share your resume referrals, any leads would be appreciated." + PAD,
                "I was laid off last week and am actively looking for a new role. DM me." + PAD,
                "Seeking a new opportunity as a backend engineer. Immediate joiner, notice period 0 days." + PAD,
                "Looking for a job in software development. Please refer me if you have openings." + PAD }) {
            var s = PostSignals.judge(p);
            assertEquals(PostSignals.Band.CLEAR_NOT, s.band(), p + " -> " + s.reason());
        }
    }

    @Test
    void ordinaryPostsAreNotHiringPosts() {
        for (String p : new String[] {
                "Congratulations to the whole team on shipping our new platform this quarter!" + PAD,
                "Happy to share that I have completed my AWS certification after months of study." + PAD,
                "Some thoughts on why microservices are overused in small teams. A thread." + PAD }) {
            assertEquals(PostSignals.Band.CLEAR_NOT, PostSignals.judge(p).band(), p);
        }
    }

    @Test
    void tooShortToJudgeIsNotHiring() {
        assertEquals(PostSignals.Band.CLEAR_NOT, PostSignals.judge("hiring").band());
        assertEquals(PostSignals.Band.CLEAR_NOT, PostSignals.judge("").band());
        assertEquals(PostSignals.Band.CLEAR_NOT, PostSignals.judge(null).band());
    }

    // ---- the band the model is for ---------------------------------------------

    @Test
    void aSingleAmbiguousSignalGoesToTheModel() {
        var s = PostSignals.judge(
                "Great to see so many openings for engineers in the market right now. "
                + "The industry is finally recovering after a difficult two years for everyone." + PAD);
        assertEquals(PostSignals.Band.AMBIGUOUS, s.band(), s.reason());
    }

    // ---- role extraction --------------------------------------------------------

    @Test
    void theRoleIsReadWhenThePostStatesItPlainly() {
        assertEquals("Java backend developers",
                PostSignals.role("We are hiring Java backend developers with Spring experience."));
        assertEquals("React Developer",
                PostSignals.role("Job opening for React Developer at our Pune office."));
    }

    @Test
    void aRunOnSentenceDoesNotBecomeARoleTitle() {
        // Without the length guard this swallows half the post and puts it in a message.
        String r = PostSignals.role(
                "We are hiring people who are passionate about building great software "
                + "and want to grow with a fast moving company that values ownership");
        assertEquals("", r, "got: " + r);
    }
}
