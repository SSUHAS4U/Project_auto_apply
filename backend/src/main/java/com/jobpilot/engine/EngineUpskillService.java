package com.jobpilot.engine;

import com.jobpilot.service.ai.AiService;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;

/**
 * /upskill — analyze the gap between the candidate's profile and the postings the
 * engine has tracked: a skill heatmap (demand vs have) + a prioritized learning plan.
 */
@Service
public class EngineUpskillService {

    private static final String SYSTEM = """
            You are a career skills analyst. Compare the candidate's profile against the
            demand visible in these tracked postings.
            First output a STRICT JSON heatmap line, then '---', then a markdown report:
            {"heatmap":[{"skill":"","demand":0,"have":true}]}
            ---
            # Upskill report
            ## Where you already win  (skills in demand that you have — lead with these)
            ## Highest-leverage gaps  (skills demanded most that you lack, ranked by how
                                      many postings want them × how learnable they are)
            ## 30-day plan            (per gap: what to build/learn, a concrete free
                                      resource TYPE to search for, and proof-of-skill to add
                                      to the CV — a project, not a certificate claim)
            demand = number of postings mentioning it. have = true only if the profile
            really shows it. Honest, specific, no filler.""";

    private final EngineUpskillRepository reports;
    private final EngineJobRepository jobs;
    private final EngineSetupService setup;
    private final AiService ai;

    public EngineUpskillService(EngineUpskillRepository reports, EngineJobRepository jobs,
                                EngineSetupService setup, AiService ai) {
        this.reports = reports;
        this.jobs = jobs;
        this.setup = setup;
        this.ai = ai;
    }

    public EngineUpskill run(UUID userId) {
        if (!ai.isEnabled()) throw new IllegalStateException("No AI provider configured.");
        EngineProfile p = setup.get(userId);
        List<EngineJob> tracked = jobs.findRanked(userId, PageRequest.of(0, 30));
        if (tracked.isEmpty()) throw new IllegalStateException("No tracked postings yet — run Scrape + Rank first.");

        StringBuilder u = new StringBuilder("CANDIDATE PROFILE:\n")
                .append(cap(nz(p.getCandidateMd()), 4500)).append("\n\nTRACKED POSTINGS:\n");
        for (EngineJob j : tracked) {
            u.append("- ").append(nz(j.getTitle())).append(" @ ").append(nz(j.getCompany()));
            if (j.getGaps() != null) u.append(" | gaps: ").append(j.getGaps());
            String d = nz(j.getDescription());
            if (!d.isBlank()) u.append(" | ").append(cap(d, 350));
            u.append('\n');
        }

        String out = ai.complete(SYSTEM, cap(u.toString(), 14000), false, false);
        EngineUpskill r = new EngineUpskill();
        r.setUserId(userId);
        int sep = out.indexOf("---");
        if (sep > 0) {
            r.setHeatmap(extractJson(out.substring(0, sep)));
            r.setReportMd(out.substring(sep + 3).trim());
        } else {
            r.setReportMd(out);
        }
        return reports.save(r);
    }

    public List<EngineUpskill> list(UUID userId) {
        return reports.findByUserIdOrderByCreatedAtDesc(userId);
    }

    private static String extractJson(String s) {
        int a = s.indexOf('{');
        int b = s.lastIndexOf('}');
        return (a >= 0 && b > a) ? s.substring(a, b + 1) : null;
    }

    private static String nz(String s) { return s == null ? "" : s; }
    private static String cap(String s, int max) { return s.length() > max ? s.substring(0, max) : s; }
}
