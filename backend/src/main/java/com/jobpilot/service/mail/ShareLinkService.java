package com.jobpilot.service.mail;

import com.jobpilot.domain.Profile;
import com.jobpilot.domain.SharedDoc;
import com.jobpilot.repository.ProfileRepository;
import com.jobpilot.repository.SharedDocRepository;
import com.jobpilot.security.UserContext;
import com.jobpilot.service.NotFoundException;
import com.jobpilot.service.documents.PdfUtil;
import com.jobpilot.service.documents.ResumeDocService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

/**
 * Links to a résumé / cover letter for a WhatsApp message.
 *
 * WhatsApp's click-to-chat URL carries text only — it cannot attach a file — so the message
 * carries links instead. Each link is a 256-bit random token (the link IS the credential, as
 * with any share link), expires after {@link #TTL}, and resolves at request time: the résumé
 * from its library row (so no copy of the bytes is kept), the cover letter from the text stored
 * with the token, rendered to PDF with the same letterhead as the emailed one.
 */
@Service
public class ShareLinkService {

    /** Long enough for a recruiter to open the message days later; short enough not to live forever. */
    static final Duration TTL = Duration.ofDays(60);

    private static final SecureRandom RANDOM = new SecureRandom();

    private final SharedDocRepository repo;
    private final ResumeDocService resumes;
    private final ProfileRepository profiles;

    /** Where recipients reach the API. Empty = derive it from the request (see ComposeController). */
    @Value("${jobpilot.public-base-url:}")
    private String publicBaseUrl;

    public ShareLinkService(SharedDocRepository repo, ResumeDocService resumes, ProfileRepository profiles) {
        this.repo = repo;
        this.resumes = resumes;
        this.profiles = profiles;
    }

    public String configuredBaseUrl() {
        return publicBaseUrl == null ? "" : publicBaseUrl.strip().replaceAll("/+$", "");
    }

    /** A link token for one of the current user's library résumés. */
    public String shareResume(UUID resumeDocId) {
        resumes.file(resumeDocId); // fails here, naming the résumé, if it has no file to share
        SharedDoc d = base(SharedDoc.RESUME);
        d.setResumeDocId(resumeDocId);
        return repo.save(d).getToken();
    }

    /** A link token for a cover letter's text. */
    public String shareCover(String coverText) {
        if (coverText == null || coverText.isBlank()) throw new IllegalArgumentException("The cover letter is empty.");
        SharedDoc d = base(SharedDoc.COVER);
        d.setCoverText(coverText.strip());
        return repo.save(d).getToken();
    }

    private SharedDoc base(String kind) {
        SharedDoc d = new SharedDoc();
        d.setToken(newToken());
        d.setUserId(UserContext.require());
        d.setKind(kind);
        d.setCreatedAt(Instant.now());
        d.setExpiresAt(Instant.now().plus(TTL));
        return d;
    }

    static String newToken() {
        byte[] b = new byte[32];
        RANDOM.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    /** Thrown for a link past its expiry, so the page can say so rather than "not found". */
    public static class Expired extends RuntimeException {
        public Expired() { super("This link has expired. Ask the sender for a fresh one."); }
    }

    /** The file behind a public link. No signed-in user on this request — the token decides. */
    public ResumeDocService.ResumeFile resolve(String token) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{20,64}")) throw new NotFoundException("link not found");
        SharedDoc d = repo.findById(token).orElseThrow(() -> new NotFoundException("link not found"));
        if (d.getExpiresAt().isBefore(Instant.now())) throw new Expired();
        if (SharedDoc.RESUME.equals(d.getKind())) {
            return resumes.fileFor(d.getUserId(), d.getResumeDocId())
                    .orElseThrow(() -> new NotFoundException("This résumé was removed by its owner."));
        }
        Profile p = profiles.findByUserId(d.getUserId()).orElse(new Profile());
        byte[] pdf = PdfUtil.textToPdf(ComposeService.coverDocument(p, d.getCoverText()));
        return new ResumeDocService.ResumeFile(pdf, "CoverLetter_" + ComposeService.safeName(p.getFullName()) + ".pdf",
                "application/pdf");
    }
}
