package com.jobpilot.service;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.ai.AiService;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Conversational helper. Answers questions about filling the profile and finding
 * jobs. Pulls candidate jobs from the local DB matching the user's message and
 * lets the model reference them, so it can "find jobs by a summary".
 */
@Service
public class AssistantService {

    private static final String SYSTEM = """
            You are JobPilot's assistant. You help the user (1) complete their profile and
            (2) find relevant jobs from the jobs already in their database. Be concise and
            practical. When jobs are provided as context, recommend the best matches by title
            and company and explain briefly why. Never invent jobs that aren't in the context.""";

    private final AiService ai;
    private final ProfileService profileService;
    private final JobService jobService;

    public AssistantService(AiService ai, ProfileService profileService, JobService jobService) {
        this.ai = ai;
        this.profileService = profileService;
        this.jobService = jobService;
    }

    public Map<String, Object> chat(List<Map<String, String>> messages) {
        if (!ai.isEnabled()) {
            throw new IllegalStateException("AI is not configured — set JOBPILOT_AI_PROVIDER + key.");
        }
        String lastUser = lastUserMessage(messages);
        List<Job> jobs = jobService.keywordSearch(lastUser, 6);
        Profile p = profileService.get();

        StringBuilder ctx = new StringBuilder();
        ctx.append("USER PROFILE: ").append(nz(p.getFullName()))
                .append(", ").append(nz(p.getHeadline()))
                .append(", skills: ").append(p.getSkills() == null ? "" : String.join(", ", p.getSkills()))
                .append(", location: ").append(nz(p.getLocation())).append("\n\n");
        ctx.append("MATCHING JOBS IN DATABASE:\n");
        if (jobs.isEmpty()) {
            ctx.append("(none found — suggest the user run ingest or broaden their query)\n");
        } else {
            for (Job j : jobs) {
                ctx.append("- ").append(nz(j.getTitle())).append(" @ ").append(nz(j.getCompany()))
                        .append(" (").append(nz(j.getLocation())).append(", score ")
                        .append(j.getMatchScore() == null ? "?" : j.getMatchScore())
                        .append(", ").append(j.getApplyType()).append(")\n");
            }
        }

        StringBuilder convo = new StringBuilder();
        for (Map<String, String> m : messages) {
            convo.append(m.getOrDefault("role", "user").toUpperCase())
                    .append(": ").append(m.getOrDefault("content", "")).append("\n");
        }
        String user = ctx + "\nCONVERSATION:\n" + convo + "\nASSISTANT:";

        String reply = ai.complete(SYSTEM, user, false);

        List<Map<String, Object>> jobCards = new ArrayList<>();
        for (Job j : jobs) {
            jobCards.add(Map.of(
                    "id", j.getId().toString(),
                    "title", nz(j.getTitle()),
                    "company", nz(j.getCompany()),
                    "location", nz(j.getLocation()),
                    "applyType", j.getApplyType(),
                    "matchScore", j.getMatchScore() == null ? 0 : j.getMatchScore(),
                    "url", nz(j.getUrl())));
        }
        return Map.of("reply", reply, "jobs", jobCards);
    }

    private String lastUserMessage(List<Map<String, String>> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            if ("user".equalsIgnoreCase(messages.get(i).get("role"))) {
                return messages.get(i).getOrDefault("content", "");
            }
        }
        return "";
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }
}
