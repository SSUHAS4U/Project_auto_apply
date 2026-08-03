package com.jobpilot.agent;

import com.jobpilot.domain.Profile;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Widening the search must not make it random: the same profile has to produce the same query
 * list, in the same order, every run — otherwise "why did it apply to that?" is unanswerable.
 */
class ExpandQueriesTest {

    private final AgentService agent = new AgentService(
            Mockito.mock(AgentRunRepository.class), Mockito.mock(AgentEventRepository.class),
            Mockito.mock(AgentScheduleRepository.class), Mockito.mock(LiveFrameService.class),
            Mockito.mock(com.jobpilot.service.SettingsService.class),
            Mockito.mock(com.jobpilot.service.ProfileService.class),
            Mockito.mock(com.jobpilot.service.KeywordMatchScorer.class),
            Mockito.mock(PortalContactRepository.class), Mockito.mock(AgentMessageRepository.class),
            Mockito.mock(PortalConnectionRepository.class), Mockito.mock(com.jobpilot.service.ai.AiService.class),
            Mockito.mock(com.jobpilot.engine.EngineProfileRepository.class),
            Mockito.mock(com.jobpilot.service.NotificationService.class),
            Mockito.mock(com.jobpilot.service.MailService.class),
            Mockito.mock(com.jobpilot.repository.ProfileRepository.class),
            Mockito.mock(com.jobpilot.repository.ApplicationRepository.class));

    private Profile profileWith(String... skills) {
        Profile p = new Profile();
        p.setSkills(List.of(skills));
        return p;
    }

    @Test
    void pairsEachRoleWithTheCandidatesTechSkills() {
        List<String> q = agent.expandQueries(List.of("Full Stack Developer"),
                profileWith("Java", "React", "MongoDB"));
        assertTrue(q.contains("Full Stack Developer"), q.toString());
        assertTrue(q.contains("Full Stack Developer Java"), q.toString());
        assertTrue(q.contains("Full Stack Developer React"), q.toString());
        assertTrue(q.size() > 1, "one keyword per role is what made the search too narrow");
    }

    @Test
    void isDeterministic() {
        Profile p = profileWith("React", "Java", "Node");
        assertEquals(agent.expandQueries(List.of("Developer", "Engineer"), p),
                agent.expandQueries(List.of("Developer", "Engineer"), p));
    }

    @Test
    void isSortedSoTwoRunsSearchInTheSameOrder() {
        List<String> q = agent.expandQueries(List.of("Zeta Engineer", "Alpha Developer"),
                profileWith("Java"));
        List<String> sorted = q.stream().sorted(String::compareToIgnoreCase).toList();
        assertEquals(sorted, q);
    }

    @Test
    void skipsSkillsAlreadyImpliedByTheRole() {
        List<String> q = agent.expandQueries(List.of("Java Developer"), profileWith("Java", "React"));
        assertFalse(q.contains("Java Developer Java"), "a redundant query wastes a whole search pass");
        assertTrue(q.contains("Java Developer React"), q.toString());
    }

    @Test
    void dropsSoftSkillsThatWouldDragInNoise() {
        List<String> q = agent.expandQueries(List.of("Developer"),
                profileWith("Java", "Team collaboration", "Excellent communication"));
        assertTrue(q.stream().noneMatch((s) -> s.toLowerCase().contains("collaboration")), q.toString());
        assertTrue(q.stream().noneMatch((s) -> s.toLowerCase().contains("communication")), q.toString());
        assertTrue(q.contains("Developer Java"), q.toString());
    }

    @Test
    void deduplicates() {
        List<String> q = agent.expandQueries(List.of("Developer", "Developer", " Developer "),
                profileWith("Java", "Java"));
        assertEquals(q.size(), q.stream().distinct().count());
    }

    @Test
    void staysBoundedSoARunCannotBeSpentOnlySearching() {
        List<String> q = agent.expandQueries(
                List.of("A Developer", "B Developer", "C Developer", "D Developer", "E Developer"),
                profileWith("Java", "React", "Node", "Mongo", "Docker", "AWS", "Kafka", "Redis"));
        assertTrue(q.size() <= 12, "got " + q.size());
    }

    @Test
    void survivesAnEmptyProfile() {
        List<String> q = agent.expandQueries(List.of(), new Profile());
        assertFalse(q.isEmpty());
        assertTrue(q.contains("software engineer"));
    }

    @Test
    void ignoresBlankRoles() {
        List<String> q = agent.expandQueries(List.of("  ", "", "Developer"), profileWith("Java"));
        assertTrue(q.stream().allMatch((s) -> !s.isBlank()));
        assertTrue(q.contains("Developer"));
    }
}
