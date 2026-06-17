package com.jobpilot.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.domain.Profile;
import com.jobpilot.service.ai.AiService;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Uploads + parses a resume, uses AI to structure it, and fills the profile. */
@Service
public class ResumeAnalysisService {

    private static final String SYSTEM = """
            You extract structured data from a resume. Return STRICT JSON only, matching
            this shape (omit unknown fields, never invent):
            {
              "firstName","lastName","email","phone","headline","summary",
              "location","city","state","country",
              "currentTitle","currentCompany","yearsExperience",
              "skills":["..."],
              "links":{"github","linkedin","portfolio"},
              "experience":[{"company","title","start","end","description"}],
              "education":[{"school","degree","field","year"}],
              "certifications":[{"name","issuer","year"}]
            }""";

    private final ResumeStorageService storage;
    private final ResumeTextExtractor extractor;
    private final ProfileService profileService;
    private final AiService ai;
    private final ObjectMapper mapper = new ObjectMapper();

    public ResumeAnalysisService(ResumeStorageService storage, ResumeTextExtractor extractor,
                                 ProfileService profileService, AiService ai) {
        this.storage = storage;
        this.extractor = extractor;
        this.profileService = profileService;
        this.ai = ai;
    }

    /** Store the resume, parse it with AI, merge into profile, save, and return it. */
    public Profile analyzeAndFill(org.springframework.web.multipart.MultipartFile file) {
        // 1. Persist the file and link it to the profile.
        ResumeStorageService.Stored stored = storage.store(file);
        profileService.setResume(stored.path(), stored.filename());

        // 2. Extract text + ask the model to structure it.
        if (!ai.isEnabled()) {
            throw new IllegalStateException("AI is not configured — set JOBPILOT_AI_PROVIDER + key to auto-fill.");
        }
        String text = extractor.extract(file);
        if (text == null || text.isBlank()) {
            throw new IllegalStateException("no readable text found in resume");
        }
        String trimmed = text.length() > 8000 ? text.substring(0, 8000) : text;
        String raw = ai.complete(SYSTEM, "RESUME:\n" + trimmed, false);
        JsonNode j = parseJson(raw);
        if (j == null) throw new IllegalStateException("AI could not parse the resume into fields");

        // 3. Merge non-empty fields into the existing profile (don't clobber with blanks).
        Profile p = profileService.get();
        str(j, "firstName", p::setFirstName);
        str(j, "lastName", p::setLastName);
        if (p.getFullName() == null || p.getFullName().isBlank() || "Your Name".equals(p.getFullName())) {
            String fn = text(j, "firstName") + " " + text(j, "lastName");
            if (!fn.isBlank()) p.setFullName(fn.trim());
        }
        str(j, "email", p::setEmail);
        str(j, "phone", p::setPhone);
        str(j, "headline", p::setHeadline);
        str(j, "summary", p::setSummary);
        str(j, "location", p::setLocation);
        str(j, "city", p::setCity);
        str(j, "state", p::setState);
        str(j, "country", p::setCountry);
        str(j, "currentTitle", p::setCurrentTitle);
        str(j, "currentCompany", p::setCurrentCompany);
        str(j, "yearsExperience", p::setYearsExperience);

        List<String> skills = stringList(j.path("skills"));
        if (!skills.isEmpty()) p.setSkills(skills);

        if (j.has("links") && j.get("links").isObject()) {
            Map<String, String> links = p.getLinks() == null ? new java.util.LinkedHashMap<>() : p.getLinks();
            j.get("links").fields().forEachRemaining(e -> {
                if (e.getValue().isTextual() && !e.getValue().asText().isBlank())
                    links.put(e.getKey(), e.getValue().asText());
            });
            p.setLinks(links);
        }
        List<Map<String, Object>> exp = objectList(j.path("experience"));
        if (!exp.isEmpty()) p.setExperience(exp);
        List<Map<String, Object>> edu = objectList(j.path("education"));
        if (!edu.isEmpty()) p.setEducation(edu);
        List<Map<String, Object>> certs = objectList(j.path("certifications"));
        if (!certs.isEmpty()) p.setCertifications(certs);

        return profileService.save(p);
    }

    private void str(JsonNode j, String field, java.util.function.Consumer<String> setter) {
        String v = text(j, field);
        if (!v.isBlank()) setter.accept(v);
    }

    private String text(JsonNode j, String field) {
        return j.path(field).asText("").trim();
    }

    private List<String> stringList(JsonNode arr) {
        List<String> out = new ArrayList<>();
        if (arr != null && arr.isArray()) arr.forEach(n -> { if (n.isTextual()) out.add(n.asText()); });
        return out;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> objectList(JsonNode arr) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (arr != null && arr.isArray()) {
            for (JsonNode n : arr) {
                if (n.isObject()) out.add(mapper.convertValue(n, Map.class));
            }
        }
        return out;
    }

    private JsonNode parseJson(String raw) {
        if (raw == null) return null;
        int s = raw.indexOf('{'), e = raw.lastIndexOf('}');
        if (s < 0 || e <= s) return null;
        try { return mapper.readTree(raw.substring(s, e + 1)); } catch (Exception ex) { return null; }
    }
}
