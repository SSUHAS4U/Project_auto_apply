package com.jobpilot.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.domain.Application;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.repository.ApplicationRepository;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

/**
 * Provider-agnostic assistant agent. It can SEARCH the user's job database and UPDATE
 * their profile, then answer naturally — using WHICHEVER model is selected in Settings
 * (Gemini / Ollama / Groq). Tools are driven by a simple text protocol (the model emits
 * a small JSON when it wants a tool), so every provider runs the whole thing on its own —
 * no single provider is hard-wired as the tool-runner.
 */
@Service
public class AssistantService {

    private static final Logger log = LoggerFactory.getLogger(AssistantService.class);
    private static final Set<String> TOOL_NAMES =
            Set.of("search_jobs", "update_profile", "get_profile", "get_applications");
    private static final int MAX_ROUNDS = 4;

    private final AiService ai;
    private final ProfileService profileService;
    private final JobService jobService;
    private final ApplicationRepository appRepo;
    private final ObjectMapper mapper = new ObjectMapper();

    public AssistantService(AiService ai, ProfileService profileService,
                            JobService jobService, ApplicationRepository appRepo) {
        this.ai = ai;
        this.profileService = profileService;
        this.jobService = jobService;
        this.appRepo = appRepo;
    }

    public Map<String, Object> chat(List<Map<String, String>> history) {
        if (!ai.isEnabled()) {
            throw new IllegalStateException("AI is not configured — pick a model in Settings.");
        }
        return runAgent(profileService.get(), history);
    }

    // ---- Agent loop (works with any provider via AiService) ----------------
    private Map<String, Object> runAgent(Profile p, List<Map<String, String>> history) {
        String system = systemPrompt(p);
        StringBuilder transcript = new StringBuilder("CONVERSATION:\n");
        for (Map<String, String> m : history) {
            transcript.append(m.getOrDefault("role", "user").toUpperCase()).append(": ")
                    .append(m.getOrDefault("content", "")).append("\n");
        }

        List<Map<String, Object>> collectedJobs = new ArrayList<>();
        String finalReply = null;

        for (int round = 0; round < MAX_ROUNDS; round++) {
            boolean forceReply = round == MAX_ROUNDS - 1;
            String ask = transcript + (forceReply
                    ? "\nReply to the user now in plain, natural language. Do NOT output JSON or tool calls."
                    : "\nIf a tool is needed, output ONLY the tool JSON. Otherwise, reply to the user in plain language.");
            String resp;
            try {
                resp = ai.complete(system, ask, false).strip();
            } catch (Exception e) {
                log.warn("assistant completion failed: {}", e.getMessage());
                break;
            }

            ToolCall tc = forceReply ? null : parseToolCall(resp);
            if (tc == null) { finalReply = cleanReply(resp); break; }

            String result = executeTool(tc.name(), tc.args(), collectedJobs);
            transcript.append("ASSISTANT(tool ").append(tc.name()).append("): ").append(resp).append("\n");
            transcript.append("TOOL_RESULT: ").append(result).append("\n");
        }

        if (finalReply == null || finalReply.isBlank()) {
            finalReply = collectedJobs.isEmpty()
                    ? "I'm your job assistant — ask me to find roles (e.g. \"fresher Java jobs in India\") or to update your profile."
                    : "Here are the closest matches I found. Want me to narrow it down?";
        }
        return Map.of("reply", finalReply.strip(), "jobs", collectedJobs);
    }

    /** Detect a tool call: a JSON object whose "tool" is one of our known tools. */
    private ToolCall parseToolCall(String resp) {
        String t = resp.trim();
        if (t.startsWith("```")) t = t.replaceAll("(?s)```(json)?", "").trim();
        int a = t.indexOf('{'), b = t.lastIndexOf('}');
        if (a < 0 || b <= a) return null;
        // Only treat as a tool call if the JSON is essentially the whole reply (avoids
        // misfiring when a normal answer happens to contain braces).
        if (a > 8) return null;
        try {
            JsonNode node = mapper.readTree(t.substring(a, b + 1));
            String tool = node.path("tool").asText("");
            if (!TOOL_NAMES.contains(tool)) return null;
            JsonNode args = node.has("args") && node.get("args").isObject() ? node.get("args") : mapper.createObjectNode();
            return new ToolCall(tool, args);
        } catch (Exception e) {
            return null;
        }
    }

    /** If the model accidentally left JSON/fences in a normal reply, tidy it. */
    private String cleanReply(String resp) {
        String t = resp.trim();
        if (t.startsWith("```")) t = t.replaceAll("(?s)```(json)?", "").trim();
        return t;
    }

    private record ToolCall(String name, JsonNode args) {}

    private String executeTool(String name, JsonNode args, List<Map<String, Object>> collectedJobs) {
        try {
            return switch (name) {
                case "search_jobs" -> {
                    List<Map<String, Object>> jobs = searchJobs(args);
                    collectedJobs.clear();
                    collectedJobs.addAll(jobs);
                    yield mapper.writeValueAsString(Map.of("count", jobs.size(), "jobs", jobs));
                }
                case "update_profile" -> updateProfile(args);
                case "get_profile" -> mapper.writeValueAsString(profileSummary(profileService.get()));
                case "get_applications" -> mapper.writeValueAsString(applicationsSummary());
                default -> "{\"error\":\"unknown tool\"}";
            };
        } catch (Exception e) {
            return "{\"error\":\"" + e.getMessage() + "\"}";
        }
    }

    private List<Map<String, Object>> searchJobs(JsonNode args) {
        String kw = args.path("keywords").asText("");
        String region = args.has("region") ? args.path("region").asText() : null;
        int fresh = args.path("freshDays").asInt(0);
        int minScore = args.path("minScore").asInt(0);

        List<Job> pool = jobService.keywordSearch(kw.isBlank() ? "developer engineer" : kw, 60);
        Instant cutoff = fresh > 0 ? Instant.now().minus(fresh, ChronoUnit.DAYS) : null;
        List<Map<String, Object>> out = new ArrayList<>();
        for (Job j : pool) {
            if (region != null && !region.isBlank() && !region.equalsIgnoreCase(j.getRegion())) continue;
            if (minScore > 0 && (j.getMatchScore() == null || j.getMatchScore() < minScore)) continue;
            if (cutoff != null && j.getPostedAt() != null && j.getPostedAt().isBefore(cutoff)) continue;
            out.add(jobCard(j));
            if (out.size() >= 8) break;
        }
        return out;
    }

    private String updateProfile(JsonNode args) throws Exception {
        Profile p = profileService.get();
        List<String> changed = new ArrayList<>();
        if (args.has("skills")) {
            List<String> incoming = new ArrayList<>();
            JsonNode sn = args.get("skills");
            if (sn.isArray()) sn.forEach(n -> incoming.add(n.asText().trim()));
            else if (sn.isTextual()) for (String s : sn.asText().split(",")) incoming.add(s.trim());
            List<String> merged = new ArrayList<>(p.getSkills() == null ? List.of() : p.getSkills());
            for (String s : incoming) {
                if (!s.isBlank() && merged.stream().noneMatch(x -> x.equalsIgnoreCase(s))) merged.add(s);
            }
            p.setSkills(merged); changed.add("skills");
        }
        changed.addAll(setIf(args, "headline", p::setHeadline));
        changed.addAll(setIf(args, "summary", p::setSummary));
        changed.addAll(setIf(args, "expectedCtc", p::setExpectedCtc));
        changed.addAll(setIf(args, "currentCtc", p::setCurrentCtc));
        changed.addAll(setIf(args, "noticePeriod", p::setNoticePeriod));
        changed.addAll(setIf(args, "availableFrom", p::setAvailableFrom));
        changed.addAll(setIf(args, "location", p::setLocation));
        changed.addAll(setIf(args, "location2", p::setLocation2));
        changed.addAll(setIf(args, "seniority", p::setSeniority));
        changed.addAll(setIf(args, "yearsExperience", p::setYearsExperience));
        changed.addAll(setIf(args, "currentTitle", p::setCurrentTitle));
        changed.addAll(setIf(args, "currentCompany", p::setCurrentCompany));
        changed.addAll(setIf(args, "college", p::setCollege));
        if (args.has("willingToRelocate")) { p.setWillingToRelocate(args.get("willingToRelocate").asBoolean()); changed.add("willingToRelocate"); }
        if (changed.isEmpty()) return mapper.writeValueAsString(Map.of("updated", false, "message", "no recognised fields"));
        profileService.save(p);
        return mapper.writeValueAsString(Map.of("updated", true, "fields", changed));
    }

    private List<String> setIf(JsonNode args, String key, java.util.function.Consumer<String> setter) {
        if (args.has(key) && !args.get(key).isNull()) {
            String v = args.get(key).asText();
            if (!v.isBlank()) { setter.accept(v); return List.of(key); }
        }
        return List.of();
    }

    // ---- Prompt + summaries -----------------------------------------------
    private String systemPrompt(Profile p) {
        return """
                You are JobPilot's assistant for %s — an early-career software engineer in India.
                Be warm, concise, specific and conversational. Always answer the ACTUAL message.
                Candidate — name: %s, headline: "%s", experience: %s yrs, location: %s, skills: %s.

                You can use these tools to help (the database is the user's own):
                - search_jobs  args: {"keywords": string, "region"?: "india"|"remote"|"outside", "freshDays"?: int, "minScore"?: int}
                - update_profile  args: {"skills"?: [..], "headline"?, "summary"?, "expectedCtc"?, "currentCtc"?, "noticePeriod"?, "availableFrom"?, "location"?, "seniority"?, "yearsExperience"?, "currentTitle"?, "currentCompany"?, "college"?, "willingToRelocate"?: bool}
                - get_profile  args: {}
                - get_applications  args: {}

                TO CALL A TOOL, output ONLY this JSON on its own, nothing else:
                {"tool":"search_jobs","args":{"keywords":"java fresher backend","region":"india"}}

                RULES:
                - Use a tool ONLY when the message needs it (finding jobs, reading/changing the
                  profile, or applications). For greetings, thanks, opinions and general questions,
                  DO NOT use any tool — just reply naturally.
                - Never show JSON, tool names, or raw data to the user in a normal reply.
                - skills are ADDED to existing ones; keep CTC in the user's words (e.g. "9 LPA").
                - After search_jobs, recommend the best 2-3 (title, company, and why).
                - Only say a profile change is done after update_profile returns "updated": true.
                """.formatted(nz(p.getFullName()), nz(p.getFullName()), nz(p.getHeadline()),
                nz(p.getYearsExperience()), nz(p.getLocation()),
                p.getSkills() == null ? "" : String.join(", ", p.getSkills()));
    }

    private Map<String, Object> profileSummary(Profile p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("fullName", p.getFullName()); m.put("headline", p.getHeadline());
        m.put("seniority", p.getSeniority()); m.put("yearsExperience", p.getYearsExperience());
        m.put("skills", p.getSkills()); m.put("location", p.getLocation());
        m.put("college", p.getCollege());
        m.put("expectedCtc", p.getExpectedCtc()); m.put("currentCompany", p.getCurrentCompany());
        m.put("resume", p.getResumeFilename() != null);
        return m;
    }

    private Map<String, Object> applicationsSummary() {
        List<Application> apps = appRepo.findAllByOrderByUpdatedAtDesc();
        Map<String, Long> byStatus = new LinkedHashMap<>();
        apps.forEach(a -> byStatus.merge(a.getStatus(), 1L, Long::sum));
        return Map.of("total", apps.size(), "byStatus", byStatus);
    }

    private Map<String, Object> jobCard(Job j) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", j.getId().toString()); m.put("title", nz(j.getTitle()));
        m.put("company", nz(j.getCompany())); m.put("location", nz(j.getLocation()));
        m.put("applyType", j.getApplyType()); m.put("matchScore", j.getMatchScore() == null ? 0 : j.getMatchScore());
        m.put("url", nz(j.getUrl()));
        return m;
    }

    private static String nz(String s) { return s == null ? "" : s; }
}
