package com.jobpilot.engine;

import com.jobpilot.service.ai.AiService;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;

/**
 * /interview — build a stage-specific prep pack from the application's OWN archive:
 * the exact posting, the CV and letter the interviewer actually read, and recorded
 * outcome notes. Gaps get honest bridge answers, never invented experience.
 * (No web browsing server-side: company knowledge is derived from the posting itself
 * and clearly marked "verify before use".)
 */
@Service
public class EngineInterviewService {

    private static final String SYSTEM = """
            You are an interview prep coach. Build a prep pack for the given interview stage
            from the application's archive. Sections (markdown):
            # Prep pack — [role] @ [company] ([stage])
            ## What they hired for  (top needs, from the posting)
            ## What you told them   (key claims from the submitted CV/letter — be ready to
                                    defend each with a real story)
            ## Likely questions → your STAR answers  (8-10 questions mapped to the
                                    candidate's real STAR examples; cite which example)
            ## Honest bridges       (for each gap, a truthful bridge answer — never invent)
            ## Questions to ask them (5, specific to this role/company)
            ## Company research checklist (what to verify before the interview — you have
                                    no live web access, so list what to look up, not facts)
            Ground everything in the provided material only.""";

    private final EngineInterviewRepository interviews;
    private final EngineApplyService applies;
    private final EngineSetupService setup;
    private final AiService ai;

    public EngineInterviewService(EngineInterviewRepository interviews, EngineApplyService applies,
                                  EngineSetupService setup, AiService ai) {
        this.interviews = interviews;
        this.applies = applies;
        this.setup = setup;
        this.ai = ai;
    }

    public EngineInterview generate(UUID userId, UUID applicationId, String stageLabel) {
        if (!ai.isEnabled()) throw new IllegalStateException("No AI provider configured.");
        EngineApplication a = applies.owned(userId, applicationId);
        EngineProfile p = setup.get(userId);

        String user = "INTERVIEW STAGE: " + stageLabel
                + "\n\nPOSTING (" + nz(a.getPostingTitle()) + " @ " + nz(a.getPostingCompany()) + "):\n"
                + cap(nz(a.getPostingText()), 4000)
                + "\n\nSUBMITTED CV (LaTeX):\n" + cap(nz(a.getCvLatex()), 4000)
                + "\n\nSUBMITTED COVER LETTER (LaTeX):\n" + cap(nz(a.getCoverLatex()), 2000)
                + "\n\nOUTCOME NOTES SO FAR:\n" + cap(nz(a.getOutcomeNotes()), 800)
                + "\n\nCANDIDATE'S STAR EXAMPLES (07-interview-prep):\n" + cap(nz(p.getInterviewPrepMd()), 4000);

        EngineInterview i = new EngineInterview();
        i.setUserId(userId);
        i.setApplicationId(applicationId);
        i.setStageLabel(stageLabel);
        i.setPackMd(ai.complete(SYSTEM, user, false, false));
        return interviews.save(i);
    }

    public List<EngineInterview> list(UUID userId) {
        return interviews.findByUserIdOrderByCreatedAtDesc(userId);
    }

    private static String nz(String s) { return s == null ? "" : s; }
    private static String cap(String s, int max) { return s.length() > max ? s.substring(0, max) : s; }
}
