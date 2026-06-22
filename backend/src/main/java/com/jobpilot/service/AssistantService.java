package com.jobpilot.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.domain.Application;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.repository.ApplicationRepository;
import com.jobpilot.service.ai.AiService;
import com.jobpilot.service.ai.GroqAiClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A real assistant agent. Using Groq function-calling it can SEARCH the user's job
 * database and UPDATE the user's profile, then answer naturally. Falls back to a
 * context-grounded chat (no tools) for non-Groq providers.
 */
@Service
public class AssistantService {

    private static final Logger log = LoggerFactory.getLogger(AssistantService.class);

    private final AiService ai;
    private final GroqAiClient groq;
    private final ProfileService profileService;
    private final JobService jobService;
    private final ApplicationRepository appRepo;
    private final ObjectMapper mapper = new ObjectMapper();

    public AssistantService(AiService ai, GroqAiClient groq, ProfileService profileService,
                            JobService jobService, ApplicationRepository appRepo) {
        this.ai = ai;
        this.groq = groq;
        this.profileService = profileService;
        this.jobService = jobService;
        this.appRepo = appRepo;
    }

    public Map<String, Object> chat(List<Map<String, String>> history) {
        if (!ai.isEnabled()) {
            throw new IllegalStateException("AI is not configured — pick a model in Settings.");
        }
        Profile p = profileService.get();

        // Intent routing: only job-search / profile-edit / applications messages need the
        // Groq function-calling agent (its tool calls are the most reliable). PLAIN
        // conversation uses whichever model you picked in the switcher (Gemini/Ollama/Groq).
        if (groq.isConfigured() && needsTools(history)) {
            try {
                return runAgent(systemPrompt(p, true), history);
            } catch (Exception e) {
                log.warn("Agent run failed ({}); falling back to grounded chat", e.getMessage());
            }
        }
        return groundedChat(systemPrompt(p, false), history);
    }

    // Does the latest message actually need a tool (search jobs / edit profile / read apps)?
    private boolean needsTools(List<Map<String, String>> history) {
        String m = lastUser(history).toLowerCase();
        if (m.isBlank()) return false;
        boolean wantsJobs = m.matches(".*\\b(job|jobs|role|roles|opening|openings|position|positions|vacanc\\w*|internship|hiring)\\b.*")
                || m.matches(".*\\b(find|search|show|list|recommend|suggest|looking for)\\b.*\\b(java|python|react|node|backend|frontend|fullstack|remote|fresher|developer|engineer|sde)\\b.*");
        boolean wantsEdit = m.matches(".*\\b(add|set|update|change|remove|make)\\b.*")
                && m.matches(".*\\b(skill|skills|ctc|salary|package|notice|headline|summary|experience|relocat\\w*|location|company|title|profile|expected|current)\\b.*");
        boolean wantsApps = (m.contains("application") || m.contains("applied"))
                && (m.contains("how many") || m.contains(" my ") || m.startsWith("my ") || m.contains("track"));
        return wantsJobs || wantsEdit || wantsApps;
    }

    private boolean wantsJobs(String msg) {
        String m = msg.toLowerCase();
        return m.matches(".*\\b(job|jobs|role|roles|opening|openings|position|positions|vacanc\\w*|internship|hiring)\\b.*");
    }

    // ---- Agent loop (Groq tool-calling) -----------------------------------
    private Map<String, Object> runAgent(String system, List<Map<String, String>> history) {
        List<Map<String, Object>> messages = new ArrayList<>();
        messages.add(msg("system", system));
        for (Map<String, String> m : history) {
            messages.add(msg(m.getOrDefault("role", "user"), m.getOrDefault("content", "")));
        }

        List<Map<String, Object>> collectedJobs = new ArrayList<>();
        String finalReply = null;
        final int maxRounds = 4;

        for (int round = 0; round < maxRounds; round++) {
            // On the final round, drop the tools so the model MUST answer in words
            // (prevents an endless tool loop on greetings/chitchat).
            boolean allowTools = round < maxRounds - 1;
            JsonNode aiMsg = groq.chat(messages, allowTools ? TOOLS : null);
            JsonNode toolCalls = aiMsg.path("tool_calls");
            if (!toolCalls.isArray() || toolCalls.isEmpty()) {
                finalReply = aiMsg.path("content").asText("");
                break;
            }
            // Echo the assistant tool-call message back, then answer each call.
            Map<String, Object> assistantEcho = new LinkedHashMap<>();
            assistantEcho.put("role", "assistant");
            assistantEcho.put("content", aiMsg.path("content").asText(""));
            assistantEcho.put("tool_calls", mapper.convertValue(toolCalls, List.class));
            messages.add(assistantEcho);

            for (JsonNode call : toolCalls) {
                String id = call.path("id").asText();
                String name = call.path("function").path("name").asText();
                JsonNode args = parseArgs(call.path("function").path("arguments").asText("{}"));
                String result = executeTool(name, args, collectedJobs);
                Map<String, Object> toolMsg = new LinkedHashMap<>();
                toolMsg.put("role", "tool");
                toolMsg.put("tool_call_id", id);
                toolMsg.put("name", name);
                toolMsg.put("content", result);
                messages.add(toolMsg);
            }
        }

        // Safety net: if the model only ever called tools (never produced text), force
        // one tool-free completion so the user ALWAYS gets a real, natural reply.
        if (finalReply == null || finalReply.isBlank()) {
            try {
                finalReply = groq.chat(messages, null).path("content").asText("");
            } catch (Exception e) {
                log.warn("forced final completion failed: {}", e.getMessage());
            }
        }
        if (finalReply == null || finalReply.isBlank()) {
            finalReply = collectedJobs.isEmpty()
                    ? "I'm your job assistant — ask me to find roles (e.g. \"fresher Java jobs in India\") or to update your profile."
                    : "Here are the closest matches I found. Want me to narrow it down?";
        }
        return Map.of("reply", finalReply.strip(), "jobs", collectedJobs);
    }

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
            // Merge into existing skills (case-insensitive dedupe).
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

    // ---- Conversational chat (uses the SELECTED model: Gemini/Ollama/Groq) -----
    // Only pulls in jobs when the message is actually about jobs, so greetings and
    // general questions get a clean, natural answer rather than forced recommendations.
    private Map<String, Object> groundedChat(String system, List<Map<String, String>> history) {
        String last = lastUser(history);
        List<Job> jobs = wantsJobs(last) ? jobService.keywordSearch(last, 6) : List.of();

        StringBuilder ctx = new StringBuilder();
        if (!jobs.isEmpty()) {
            ctx.append("RELEVANT JOBS FROM THEIR DATABASE (recommend the best 2-3 with a short reason):\n");
            jobs.forEach(j -> ctx.append("- ").append(j.getTitle()).append(" @ ").append(nz(j.getCompany()))
                    .append(" (").append(nz(j.getLocation())).append(", match ").append(j.getMatchScore()).append(")\n"));
            ctx.append("\n");
        }
        StringBuilder convo = new StringBuilder();
        history.forEach(m -> convo.append(m.getOrDefault("role", "user").toUpperCase()).append(": ")
                .append(m.getOrDefault("content", "")).append("\n"));

        String reply = ai.complete(system,
                ctx + "CONVERSATION:\n" + convo + "\nReply as the assistant — natural, concise, and to the point:", false);
        List<Map<String, Object>> cards = new ArrayList<>();
        jobs.forEach(j -> cards.add(jobCard(j)));
        return Map.of("reply", reply == null ? "" : reply.strip(), "jobs", cards);
    }

    // ---- Helpers ----------------------------------------------------------
    private String systemPrompt(Profile p, boolean withTools) {
        String base = """
                You are JobPilot's assistant — a friendly, conversational helper for %s, an
                early-career software engineer in India. Talk like a helpful person: warm, concise,
                specific. Answer the ACTUAL message. If they just say "hi"/"thanks"/ask a general
                question, reply naturally in 1-2 sentences — do not dump a canned script.
                Candidate context — name: %s, headline: "%s", experience: %s yrs, location: %s,
                skills: %s.
                """.formatted(nz(p.getFullName()), nz(p.getFullName()), nz(p.getHeadline()),
                nz(p.getYearsExperience()), nz(p.getLocation()),
                p.getSkills() == null ? "" : String.join(", ", p.getSkills()));
        if (!withTools) return base + "\nUse the provided jobs to recommend the best matches by title + company when relevant.";
        return base + """

                You have tools — but use them ONLY when the message clearly needs them:
                - search_jobs: ONLY when the user asks to find / search / show jobs.
                - update_profile: ONLY when the user asks to change/add/set something on their profile
                  (skills are ADDED to existing; keep CTC in their words, e.g. "9 LPA").
                - get_profile / get_applications: ONLY when they ask about their own profile/applications.

                For greetings, thanks, or general chat, DO NOT call any tool — just reply naturally.
                After a tool runs, ALWAYS write a natural-language reply: summarise the 2-3 best job
                matches (title, company, why) or confirm exactly what changed. Never reply empty, and
                never claim a profile change is done until update_profile returns updated:true.""";
    }

    private Map<String, Object> profileSummary(Profile p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("fullName", p.getFullName()); m.put("headline", p.getHeadline());
        m.put("seniority", p.getSeniority()); m.put("yearsExperience", p.getYearsExperience());
        m.put("skills", p.getSkills()); m.put("location", p.getLocation());
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

    private Map<String, Object> msg(String role, String content) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("role", role); m.put("content", content);
        return m;
    }

    private JsonNode parseArgs(String json) {
        try { return mapper.readTree(json == null || json.isBlank() ? "{}" : json); }
        catch (Exception e) { return mapper.createObjectNode(); }
    }

    private String lastUser(List<Map<String, String>> h) {
        for (int i = h.size() - 1; i >= 0; i--) if ("user".equalsIgnoreCase(h.get(i).get("role"))) return h.get(i).getOrDefault("content", "");
        return "";
    }

    private static String nz(String s) { return s == null ? "" : s; }

    // ---- Tool definitions (OpenAI/Groq schema) ----------------------------
    private static final List<Map<String, Object>> TOOLS = List.of(
            tool("search_jobs", "Search the user's job database for relevant tech roles.", Map.of(
                    "type", "object",
                    "properties", Map.of(
                            "keywords", Map.of("type", "string", "description", "role/skill keywords, e.g. 'java fresher backend'"),
                            "region", Map.of("type", "string", "enum", List.of("india", "remote", "outside")),
                            "freshDays", Map.of("type", "integer", "description", "only jobs posted within N days"),
                            "minScore", Map.of("type", "integer", "description", "minimum match score 0-100")),
                    "required", List.of("keywords"))),
            tool("update_profile", "Update fields on the user's profile.", Map.of(
                    "type", "object",
                    "properties", Map.ofEntries(
                            Map.entry("skills", Map.of("type", "array", "items", Map.of("type", "string"))),
                            Map.entry("headline", Map.of("type", "string")),
                            Map.entry("summary", Map.of("type", "string")),
                            Map.entry("expectedCtc", Map.of("type", "string")),
                            Map.entry("currentCtc", Map.of("type", "string")),
                            Map.entry("noticePeriod", Map.of("type", "string")),
                            Map.entry("availableFrom", Map.of("type", "string")),
                            Map.entry("location", Map.of("type", "string")),
                            Map.entry("location2", Map.of("type", "string")),
                            Map.entry("seniority", Map.of("type", "string")),
                            Map.entry("yearsExperience", Map.of("type", "string")),
                            Map.entry("currentTitle", Map.of("type", "string")),
                            Map.entry("currentCompany", Map.of("type", "string")),
                            Map.entry("willingToRelocate", Map.of("type", "boolean"))))),
            tool("get_profile", "Get the user's current profile summary.", Map.of("type", "object", "properties", Map.of())),
            tool("get_applications", "Get a summary of the user's tracked applications.", Map.of("type", "object", "properties", Map.of()))
    );

    private static Map<String, Object> tool(String name, String desc, Map<String, Object> params) {
        return Map.of("type", "function", "function",
                Map.of("name", name, "description", desc, "parameters", params));
    }
}
