package com.jobpilot.web;

import com.jobpilot.service.EmailApplyService;
import org.springframework.web.bind.annotation.*;

import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api")
public class ApplyController {

    private final EmailApplyService emailApply;

    public ApplyController(EmailApplyService emailApply) {
        this.emailApply = emailApply;
    }

    /** Generate (but do not send) a cover letter for review. */
    @PostMapping("/cover-letter/preview")
    public Map<String, Object> preview(@RequestBody Map<String, String> body) {
        UUID jobId = UUID.fromString(body.get("jobId"));
        return Map.of("jobId", jobId.toString(), "coverLetter", emailApply.previewCoverLetter(jobId));
    }

    /** Full automation path (Feature #6): send resume + cover letter via SMTP. */
    @PostMapping("/apply/email/{jobId}")
    public EmailApplyService.ApplyResult applyEmail(@PathVariable UUID jobId,
                                                    @RequestBody(required = false) Map<String, String> body) {
        String override = body == null ? null : body.get("coverLetter");
        return emailApply.apply(jobId, override);
    }
}
