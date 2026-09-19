package com.jobpilot.service.jobs;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Where a scouted listing says it came from.
 *
 * Scout derived the source from the URL's host. That is correct for LinkedIn, which hands back
 * a direct /jobs/view link — and useless for Jooble, which returns a jooble.org/jdp/… redirect
 * for every single result and names the real board in a separate field. Labelling by host meant
 * every aggregated listing read "jooble", which tells the reader nothing about who is hiring.
 */
class ScoutOriginTest {

    @Test
    void aConnectorSuppliedOriginWinsOverTheRedirectHost() {
        // The exact shape seen live: link is a jooble redirect, origin is the real board.
        assertEquals("decentrajobs.com",
                JobScoutService.originSite("decentrajobs.com", "https://jooble.org/jdp/-8267810394167984723"));
    }

    @Test
    void originIsNormalisedBeforeItIsStored() {
        assertEquals("ceipal.com", JobScoutService.originSite("https://www.Ceipal.com/jobs/123", null));
        assertEquals("jobs.dish.com", JobScoutService.originSite("  JOBS.DISH.COM  ", null));
    }

    @Test
    void aKnownSiteKeepsItsCanonicalKeySoTheUiFilterStillGroupsIt() {
        // Otherwise an origin of "in.linkedin.com" would become its own filter entry sitting
        // next to "linkedin", splitting one source across two options.
        assertEquals("linkedin", JobScoutService.originSite("www.linkedin.com", null));
        assertEquals("careerjet", JobScoutService.originSite("careerjet.co.in", null));
    }

    @Test
    void withNoOriginItFallsBackToTheUrlHost() {
        assertEquals("linkedin",
                JobScoutService.originSite(null, "https://www.linkedin.com/jobs/view/4466641695"));
        assertEquals("other", JobScoutService.originSite("", "https://example.com/careers/1"));
    }
}
