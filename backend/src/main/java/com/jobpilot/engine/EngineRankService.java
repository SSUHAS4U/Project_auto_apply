package com.jobpilot.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.service.ai.AiService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * /rank — batch triage of newly scraped postings, clean-room per the repo:
 * deal-breaker vetoes apply FIRST, dead postings get marked expired, the rest are
 * scored with per-job strengths/gaps and returned as a ranked shortlist.
 */
@Service
public class EngineRankService {

    private static final Logger log = LoggerFactory.getLogger(EngineRankService.class);
    private static final int BATCH = 6;          // postings per AI call
    private static final int MAX_PER_RUN = 30;   // AI budget per /rank run

    private static final String SYSTEM = """
            You are a job-fit triage engine. For EACH posting in the batch, score the
            candidate's fit honestly:
            - First check DEAL-BREAKERS from the candidate's evaluation lens; if one applies,
              set "dealBreaker" to the exact reason and skip scoring (fit=0).
            - Otherwise score fit 0-100 weighing: skill match, experience level alignment
              (early-career candidates score HIGH on junior roles, LOW on 5+ yr roles),
              location/remote compatibility, and career-goal alignment.
            - verdict: strong(75+) good(60-74) moderate(45-59) weak(30-44) poor(<30).
            - strengths: 2-3 concrete matches; gaps: 1-3 honest gaps. urgent=true only if
              the posting shows a near deadline.
            Never inflate. Output STRICT JSON only:
            {"results":[{"i":0,"fit":0,"verdict":"","strengths":["",""],"gaps":[""],
                         "dealBreaker":null,"urgent":false,"note":""}]}""";

    private final EngineJobRepository jobs;
    private final EngineSetupService setup;
    private final EngineScraperService scraper;
    private final AiService ai;
    private final ObjectMapper mapper = new ObjectMapper();

    private final Map<UUID, String> progress = new ConcurrentHashMap<>();
    private final Map<UUID, AtomicBoolean> running = new ConcurrentHashMap<>();

    public EngineRankService(EngineJobRepository jobs, EngineSetupService setup,
                             EngineScraperService scraper, AiService ai) {
        this.jobs = jobs;
        this.setup = setup;
        this.scraper = scraper;
        this.ai = ai;
    }

    public String progress(UUID userId) { return progress.getOrDefault(userId, ""); }
    public boolean isRunning(UUID userId) {
        return running.computeIfAbsent(userId, k -> new AtomicBoolean(false)).get();
    }

    /** Rank up to MAX_PER_RUN 'new' postings. Returns a summary. */
    public Map<String, Object> run(UUID userId) {
        if (!ai.isEnabled()) throw new IllegalStateException("No AI provider configured.");
        AtomicBoolean flag = running.computeIfAbsent(userId, k -> new AtomicBoolean(false));
        if (!flag.compareAndSet(false, true)) throw new IllegalStateException("A rank run is already in progress.");
        try {
            EngineProfile p = setup.get(userId);
            String candidate = cap(nz(p.getCandidateMd()), 5000);
            String lens = cap(nz(p.getEvaluationMd()), 2500);
            if (candidate.isBlank()) throw new IllegalStateException("Run Setup first — no candidate profile.");

            List<EngineJob> fresh = jobs.findByUserIdAndStatusOrderByScrapedAtDesc(
                    userId, "new", PageRequest.of(0, MAX_PER_RUN));
            int ranked = 0, vetoed = 0, expired = 0;
            for (int i = 0; i < fresh.size(); i += BATCH) {
                List<EngineJob> batch = fresh.subList(i, Math.min(i + BATCH, fresh.size()));
                progress.put(userId, "Ranking " + (i + 1) + "–" + (i + batch.size()) + " of " + fresh.size() + "…");

                // fetch descriptions lazily (short — triage only needs the gist)
                for (EngineJob j : batch) {
                    if (nz(j.getDescription()).isBlank() && nz(j.getUrl()).length() > 0) {
                        String d = scraper.fetchDescription(j.getUrl());
                        if (d.isBlank() && scraper.isExpired(j.getUrl())) {
                            j.setStatus("expired");
                            jobs.save(j);
                            expired++;
                            continue;
                        }
                        j.setDescription(cap(d, 4000));
                    }
                }
                List<EngineJob> alive = batch.stream().filter(j -> !"expired".equals(j.getStatus())).toList();
                if (alive.isEmpty()) continue;

                try {
                    JsonNode res = rankBatch(candidate, lens, alive);
                    for (JsonNode r : res.path("results")) {
                        int idx = r.path("i").asInt(-1);
                        if (idx < 0 || idx >= alive.size()) continue;
                        EngineJob j = alive.get(idx);
                        String veto = r.path("dealBreaker").isNull() ? null : r.path("dealBreaker").asText(null);
                        if (veto != null && !veto.isBlank() && !"null".equals(veto)) {
                            j.setDealBreaker(veto);
                            j.setFitScore(0);
                            j.setVerdict("poor");
                            j.setStatus("dismissed");
                            vetoed++;
                        } else {
                            j.setFitScore(r.path("fit").asInt(0));
                            j.setVerdict(r.path("verdict").asText(""));
                            j.setStatus(j.getFitScore() >= 60 ? "shortlisted" : "ranked");
                        }
                        j.setStrengths(joined(r.path("strengths")));
                        j.setGaps(joined(r.path("gaps")));
                        j.setUrgent(r.path("urgent").asBoolean(false));
                        j.setRankNotes(r.path("note").asText(""));
                        jobs.save(j);
                        ranked++;
                    }
                } catch (Exception e) {
                    log.warn("rank batch failed: {}", e.getMessage());
                }
            }
            progress.put(userId, "");
            long remaining = jobs.countByUserIdAndStatus(userId, "new");
            return Map.of("ranked", ranked, "vetoed", vetoed, "expired", expired, "remainingNew", remaining);
        } finally {
            flag.set(false);
            progress.put(userId, "");
        }
    }

    private JsonNode rankBatch(String candidate, String lens, List<EngineJob> batch) throws Exception {
        StringBuilder u = new StringBuilder();
        u.append("CANDIDATE PROFILE:\n").append(candidate)
         .append("\n\nCANDIDATE'S EVALUATION LENS (goals, must-haves, deal-breakers):\n")
         .append(lens.isBlank() ? "(none provided)" : lens)
         .append("\n\nPOSTINGS:\n");
        for (int i = 0; i < batch.size(); i++) {
            EngineJob j = batch.get(i);
            u.append("--- posting i=").append(i).append(" ---\n")
             .append("Title: ").append(nz(j.getTitle())).append('\n')
             .append("Company: ").append(nz(j.getCompany())).append('\n')
             .append("Location: ").append(nz(j.getLocation())).append('\n')
             .append("Posted: ").append(nz(j.getPostedAt())).append('\n')
             .append("Description: ").append(cap(nz(j.getDescription()), 1800)).append("\n\n");
        }
        String out = ai.complete(SYSTEM, cap(u.toString(), 14000), false, false);
        return mapper.readTree(extractJson(out));
    }

    private static String joined(JsonNode arr) {
        if (arr == null || !arr.isArray()) return null;
        List<String> parts = new ArrayList<>();
        arr.forEach(x -> parts.add(x.asText()));
        return parts.isEmpty() ? null : String.join(" · ", parts);
    }

    private static String extractJson(String s) {
        if (s == null) return "{}";
        int a = s.indexOf('{');
        int b = s.lastIndexOf('}');
        return (a >= 0 && b > a) ? s.substring(a, b + 1) : "{}";
    }

    private static String nz(String s) { return s == null ? "" : s; }
    private static String cap(String s, int max) { return s.length() > max ? s.substring(0, max) : s; }
}
