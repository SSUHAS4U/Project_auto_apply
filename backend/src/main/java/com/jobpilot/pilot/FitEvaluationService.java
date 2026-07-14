package com.jobpilot.pilot;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Stage 1 of the pipeline — the ai-job-search job-evaluation framework
 * (04-job-evaluation.md) run as a single structured AI call:
 *
 *   technical skills 30% · experience 25% · behavioral/culture 15% ·
 *   career alignment 30% · location pass/fail (unweighted gate)
 *
 * Verdicts: strong (75+) · good (60-74) · moderate (45-59) · weak (30-44) ·
 * poor (<30). Only strong/good proceed to drafting — the framework's
 * "apply with tailored materials" bar replaces its interactive user gate.
 * The evaluation also extracts the posting's required/preferred keywords,
 * which the ATS-verification stage later checks against the compiled CV.
 */
@Service
public class FitEvaluationService {

    private static final Logger log = LoggerFactory.getLogger(FitEvaluationService.class);

    private static final String SYSTEM = """
            You are a rigorous job-fit evaluator. Score the candidate against the posting on
            four dimensions (0-100 each) plus a location gate, exactly per this rubric:

            1. technical — required/preferred skills vs candidate capabilities.
               80-100 core match · 60-79 mostly aligned, learnable gaps · 40-59 partial,
               significant upskilling · 0-39 fundamental mismatch.
            2. experience — work-history relevance. 80-100 direct domain · 60-79 related/
               transferable · 40-59 adjacent · 0-39 unrelated. An early-career candidate
               scores HIGH on entry/junior roles and LOW on roles demanding many years.
            3. culture — role/company compatibility with the candidate's profile.
               Watch for red flags (pure maintenance work, disorganisation signals).
            4. career — does this role advance the candidate's stated direction and energise
               them? 80-100 strong growth path · 0-39 dead end.
            5. location — "pass" if the role is in/near the candidate's locations or remote;
               "fail" if it requires relocation they haven't opted into; "flag" if unclear
               or heavy travel.

            Also extract the posting's keywords: requiredKeywords (must-have hard skills,
            tools, frameworks — the ATS terms) and preferredKeywords (nice-to-have).

            Be honest and critical — do not inflate scores. Every note must cite something
            concrete from the posting or profile.

            Output STRICT JSON only, no markdown, exactly this shape:
            {"technical":{"score":0,"note":""},"experience":{"score":0,"note":""},
             "culture":{"score":0,"note":""},"career":{"score":0,"note":""},
             "location":{"result":"pass|fail|flag","note":""},
             "strengths":["",""],"gaps":["",""],"recommendation":"",
             "requiredKeywords":[""],"preferredKeywords":[""]}""";

    private final AiService ai;
    private final ObjectMapper mapper = new ObjectMapper();

    public FitEvaluationService(AiService ai) {
        this.ai = ai;
    }

    /** Result: the full evaluation JSON (with weighted score + verdict added) and the gate values. */
    public record Evaluation(String json, int weightedScore, String verdict, String locationResult,
                             List<String> requiredKeywords, List<String> preferredKeywords) {}

    public Evaluation evaluate(Job job, String jobDescription, Profile profile) {
        ObjectNode node;
        try {
            String out = ai.complete(SYSTEM,
                    "CANDIDATE PROFILE:\n" + profileBlock(profile)
                            + "\n\nJOB POSTING:\nTitle: " + job.getTitle()
                            + "\nCompany: " + safe(job.getCompany())
                            + "\nLocation: " + safe(job.getLocation()) + (job.isRemote() ? " (remote)" : "")
                            + "\nDescription:\n" + clip(jobDescription, 6000)
                            + "\n\nJSON evaluation:", false, true);
            node = (ObjectNode) mapper.readTree(extractJson(out));
        } catch (Exception e) {
            log.warn("AI evaluation failed for '{}' ({}); using deterministic fallback",
                    job.getTitle(), e.getMessage());
            node = fallback(job, jobDescription, profile);
        }
        return finish(node, profile);
    }

    /** Apply the framework's weights + verdict thresholds server-side (never trust the model's math). */
    private Evaluation finish(ObjectNode node, Profile profile) {
        int technical = dim(node, "technical");
        int experience = dim(node, "experience");
        int culture = dim(node, "culture");
        int career = dim(node, "career");
        int weighted = Math.round(technical * 0.30f + experience * 0.25f + culture * 0.15f + career * 0.30f);

        String location = node.path("location").path("result").asText("flag").toLowerCase(Locale.ROOT);
        if (!List.of("pass", "fail", "flag").contains(location)) location = "flag";

        String verdict = weighted >= 75 ? "strong" : weighted >= 60 ? "good"
                : weighted >= 45 ? "moderate" : weighted >= 30 ? "weak" : "poor";

        node.put("weighted", weighted);
        node.put("verdict", verdict);
        List<String> required = strings(node.path("requiredKeywords"));
        List<String> preferred = strings(node.path("preferredKeywords"));
        String json;
        try {
            json = mapper.writeValueAsString(node);
        } catch (Exception e) {
            json = node.toString();
        }
        return new Evaluation(json, weighted, verdict, location, required, preferred);
    }

    /** No-AI fallback: keyword overlap drives technical; neutral middle scores elsewhere. */
    private ObjectNode fallback(Job job, String jd, Profile profile) {
        String text = (safe(job.getTitle()) + " " + safe(jd)).toLowerCase(Locale.ROOT);
        List<String> skills = profile.getSkills() == null ? List.of() : profile.getSkills();
        ArrayNode reqKw = mapper.createArrayNode();
        int hits = 0;
        for (String s : skills) {
            if (s != null && s.trim().length() >= 2 && text.contains(s.toLowerCase(Locale.ROOT).trim())) {
                hits++;
                reqKw.add(s.trim());
            }
        }
        int technical = skills.isEmpty() ? 50 : Math.min(100, 30 + hits * 70 / Math.max(1, Math.min(skills.size(), 8)));

        ObjectNode n = mapper.createObjectNode();
        n.set("technical", dimNode(technical, hits + " of the profile's skills appear in the posting"));
        n.set("experience", dimNode(55, "AI unavailable — neutral estimate"));
        n.set("culture", dimNode(55, "AI unavailable — neutral estimate"));
        n.set("career", dimNode(55, "AI unavailable — neutral estimate"));
        ObjectNode loc = mapper.createObjectNode();
        loc.put("result", "flag");
        loc.put("note", "AI unavailable — location not assessed");
        n.set("location", loc);
        n.set("strengths", mapper.createArrayNode());
        n.set("gaps", mapper.createArrayNode().add("evaluation ran without AI — scores are keyword-based only"));
        n.put("recommendation", "Deterministic fallback evaluation; configure an AI provider for the full framework.");
        n.set("requiredKeywords", reqKw);
        n.set("preferredKeywords", mapper.createArrayNode());
        return n;
    }

    // ---- helpers ----------------------------------------------------------------

    static String profileBlock(Profile p) {
        StringBuilder sb = new StringBuilder();
        sb.append("Name: ").append(safe(p.getFullName()));
        if (notBlank(p.getHeadline())) sb.append("\nHeadline: ").append(p.getHeadline());
        if (notBlank(p.getCurrentTitle()))
            sb.append("\nCurrent role: ").append(p.getCurrentTitle())
              .append(notBlank(p.getCurrentCompany()) ? " @ " + p.getCurrentCompany() : "");
        if (notBlank(p.getYearsExperience())) sb.append("\nYears of experience: ").append(p.getYearsExperience());
        if (notBlank(p.getSeniority())) sb.append("\nSeniority: ").append(p.getSeniority());
        if (p.getSkills() != null && !p.getSkills().isEmpty())
            sb.append("\nSkills: ").append(String.join(", ", p.getSkills()));
        if (notBlank(p.getSummary())) sb.append("\nSummary: ").append(clip(p.getSummary(), 900));
        if (notBlank(p.getLocation())) sb.append("\nLocation: ").append(p.getLocation());
        if (p.getPreferredLocations() != null && !p.getPreferredLocations().isEmpty())
            sb.append("\nPreferred locations: ").append(String.join(", ", p.getPreferredLocations()));
        if (Boolean.TRUE.equals(p.getWillingToRelocate())) sb.append("\nWilling to relocate: yes");
        if (p.getExperience() != null) {
            sb.append("\nExperience:");
            for (Map<String, Object> e : p.getExperience()) {
                sb.append("\n - ").append(str(e.get("title"))).append(" @ ").append(str(e.get("company")))
                  .append(" (").append(str(e.get("start"))).append("–").append(str(e.get("end"))).append("): ")
                  .append(clip(str(e.get("description")), 300));
            }
        }
        if (p.getEducation() != null) {
            sb.append("\nEducation:");
            for (Map<String, Object> e : p.getEducation()) {
                sb.append("\n - ").append(str(e.get("degree"))).append(" ").append(str(e.get("field")))
                  .append(", ").append(str(e.get("school"))).append(" (").append(str(e.get("year"))).append(")");
            }
        }
        return sb.toString();
    }

    /** Lenient JSON extraction: strip fences, take the outermost object. */
    static String extractJson(String s) {
        if (s == null) throw new IllegalStateException("empty AI response");
        String t = s.trim();
        if (t.startsWith("```")) t = t.replaceAll("(?s)^```(json)?\\s*", "").replaceAll("```\\s*$", "").trim();
        int start = t.indexOf('{');
        int end = t.lastIndexOf('}');
        if (start < 0 || end <= start) throw new IllegalStateException("no JSON object in AI response");
        return t.substring(start, end + 1);
    }

    private int dim(JsonNode node, String name) {
        return Math.max(0, Math.min(100, node.path(name).path("score").asInt(0)));
    }

    private ObjectNode dimNode(int score, String note) {
        ObjectNode n = mapper.createObjectNode();
        n.put("score", score);
        n.put("note", note);
        return n;
    }

    private List<String> strings(JsonNode arr) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (arr != null && arr.isArray()) {
            arr.forEach(x -> {
                String v = x.asText("").trim();
                if (!v.isBlank()) out.add(v);
            });
        }
        return out;
    }

    static String clip(String s, int max) {
        if (s == null) return "";
        return s.length() > max ? s.substring(0, max) : s;
    }

    private static String str(Object o) { return o == null ? "" : o.toString().trim(); }
    private static String safe(String s) { return s == null ? "" : s; }
    private static boolean notBlank(String s) { return s != null && !s.isBlank(); }
}
