package com.jobpilot.service;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.domain.QaPair;
import com.jobpilot.repository.QaPairRepository;
import com.jobpilot.security.UserContext;
import com.jobpilot.service.ai.AiService;
import com.jobpilot.service.cover.CoverLetterService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Powers the extension's assisted-apply features: answering free-text application
 * questions with AI (grounded in the user's profile), a reusable Q&A bank, and
 * on-demand cover letters.
 */
@Service
public class AssistService {

    private static final String ANSWER_SYSTEM = """
            You help a job candidate fill out an application form. Write a first-person
            answer to the application question using ONLY the candidate's real background
            below. Be specific, genuine and concise — 2 to 5 sentences unless the question
            clearly needs more. Never invent employers, degrees or facts not given. No
            placeholders, no markdown, no preamble — output ONLY the answer text.""";

    private final QaPairRepository qaRepo;
    private final ProfileService profiles;
    private final AiService ai;
    private final CoverLetterService coverLetters;

    public AssistService(QaPairRepository qaRepo, ProfileService profiles,
                         AiService ai, CoverLetterService coverLetters) {
        this.qaRepo = qaRepo;
        this.profiles = profiles;
        this.ai = ai;
        this.coverLetters = coverLetters;
    }

    /** Answer a question — reuse a saved answer if we have a close match, else ask AI (and store it). */
    @Transactional
    public Map<String, Object> answer(String question) {
        if (question == null || question.isBlank()) {
            throw new IllegalArgumentException("question is required");
        }
        UUID userId = UserContext.require();
        String key = normalize(question);

        // 1. Exact key match in the bank.
        Optional<QaPair> exact = qaRepo.findByUserIdAndQuestionKey(userId, key);
        if (exact.isPresent()) {
            return Map.of("answer", exact.get().getAnswer(), "source", "saved");
        }
        // 2. Fuzzy match against the bank (token overlap) — reuse a similar answer.
        QaPair similar = bestMatch(qaRepo.findByUserIdOrderByUpdatedAtDesc(userId), key);
        if (similar != null) {
            return Map.of("answer", similar.getAnswer(), "source", "saved");
        }
        // 3. Generate with AI, grounded in the profile, then persist for reuse.
        Profile p = profiles.get();
        String prompt = "Candidate background:\n" + profileContext(p)
                + "\n\nApplication question: " + question.trim() + "\n\nAnswer:";
        String generated = ai.complete(ANSWER_SYSTEM, prompt, false, false).trim();
        save(userId, question, generated, "ai");
        return Map.of("answer", generated, "source", "ai");
    }

    /**
     * Pick the best option(s) for a multiple-choice / dropdown / rating question,
     * grounded in the candidate's profile. Returns option labels exactly as given.
     */
    public Map<String, Object> choose(String question, List<String> options, boolean multi) {
        if (question == null || question.isBlank() || options == null || options.isEmpty()) {
            throw new IllegalArgumentException("question and options are required");
        }
        Profile p = profiles.get();
        StringBuilder opts = new StringBuilder();
        for (int i = 0; i < options.size(); i++) {
            opts.append(i + 1).append(". ").append(options.get(i)).append("\n");
        }
        String system = """
                You help a candidate answer an application form. Choose the option(s) that
                best fit the candidate's real background. Prefer truthful, eligibility-friendly
                answers (e.g. willing to relocate / can start soon) when the profile doesn't
                contradict them. For rating scales, pick a number that matches the candidate's
                stated skills honestly. Reply with ONLY the option number(s); if multiple are
                allowed and several apply, separate with commas. No words, just numbers.""";
        String prompt = "Candidate background:\n" + profileContext(p)
                + "\n\nQuestion: " + question.trim()
                + "\n\nOptions:\n" + opts
                + "\n" + (multi ? "Select all that apply." : "Select exactly one.")
                + " Reply with the number(s) only:";
        String raw = ai.complete(system, prompt, true, false);

        List<String> selected = new ArrayList<>();
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\d+").matcher(raw == null ? "" : raw);
        while (m.find()) {
            int idx = Integer.parseInt(m.group()) - 1;
            if (idx >= 0 && idx < options.size() && !selected.contains(options.get(idx))) {
                selected.add(options.get(idx));
                if (!multi) break;
            }
        }
        if (selected.isEmpty() && !multi) selected.add(options.get(0)); // safe fallback
        return Map.of("selected", selected);
    }

    @Transactional
    public QaPair saveQa(String question, String answer) {
        if (question == null || question.isBlank() || answer == null || answer.isBlank()) {
            throw new IllegalArgumentException("question and answer are required");
        }
        return save(UserContext.require(), question, answer, "manual");
    }

    public List<QaPair> listQa() {
        return qaRepo.findByUserIdOrderByUpdatedAtDesc(UserContext.require());
    }

    @Transactional
    public void deleteQa(UUID id) {
        UUID userId = UserContext.require();
        qaRepo.findById(id).filter(q -> userId.equals(q.getUserId())).ifPresent(qaRepo::delete);
    }

    /** Generate a cover letter for an arbitrary listing the extension is looking at. */
    public String coverLetter(String company, String role, String jobText) {
        Profile p = profiles.get();
        Job job = new Job();
        job.setCompany(company == null || company.isBlank() ? "the company" : company.trim());
        job.setTitle(role == null || role.isBlank() ? "this role" : role.trim());
        job.setDescription(jobText == null ? "" : jobText.trim());
        return coverLetters.generate(job, p);
    }

    // ---- internals ----

    private QaPair save(UUID userId, String question, String answer, String source) {
        String key = normalize(question);
        QaPair q = qaRepo.findByUserIdAndQuestionKey(userId, key).orElseGet(QaPair::new);
        q.setUserId(userId);
        q.setQuestion(question.trim());
        q.setQuestionKey(key);
        q.setAnswer(answer.trim());
        if (q.getId() == null) q.setSource(source);
        q.setUpdatedAt(Instant.now());
        return qaRepo.save(q);
    }

    private static String normalize(String s) {
        return s.toLowerCase().replaceAll("[^a-z0-9 ]", " ").replaceAll("\\s+", " ").trim();
    }

    /** Returns a stored Q&A whose question tokens overlap the asked one strongly (Jaccard >= 0.6). */
    private QaPair bestMatch(List<QaPair> bank, String key) {
        Set<String> want = tokens(key);
        if (want.isEmpty()) return null;
        QaPair best = null;
        double bestScore = 0.6;
        for (QaPair q : bank) {
            Set<String> have = tokens(q.getQuestionKey());
            if (have.isEmpty()) continue;
            Set<String> inter = new HashSet<>(want);
            inter.retainAll(have);
            Set<String> union = new HashSet<>(want);
            union.addAll(have);
            double j = (double) inter.size() / union.size();
            if (j > bestScore) { bestScore = j; best = q; }
        }
        return best;
    }

    private static Set<String> tokens(String key) {
        return Arrays.stream(key.split(" ")).filter(t -> t.length() > 2).collect(Collectors.toSet());
    }

    private String profileContext(Profile p) {
        StringBuilder sb = new StringBuilder();
        line(sb, "Name", p.getFullName());
        line(sb, "Headline", p.getHeadline());
        line(sb, "Current role", join(p.getCurrentTitle(), p.getCurrentCompany()));
        line(sb, "Years of experience", str(p.getYearsExperience()));
        line(sb, "Location", p.getLocation());
        if (p.getSkills() != null && !p.getSkills().isEmpty()) {
            line(sb, "Skills", String.join(", ", p.getSkills()));
        }
        line(sb, "Summary", p.getSummary());
        return sb.length() == 0 ? "(no profile details on file)" : sb.toString();
    }

    private static void line(StringBuilder sb, String label, String val) {
        if (val != null && !val.isBlank()) sb.append("- ").append(label).append(": ").append(val).append("\n");
    }

    private static String join(String a, String b) {
        if (a == null || a.isBlank()) return b;
        if (b == null || b.isBlank()) return a;
        return a + " at " + b;
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }
}
