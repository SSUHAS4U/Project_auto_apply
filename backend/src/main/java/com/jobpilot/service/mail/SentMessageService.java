package com.jobpilot.service.mail;

import com.jobpilot.domain.SentMessage;
import com.jobpilot.repository.SentMessageRepository;
import com.jobpilot.security.UserContext;
import com.jobpilot.service.NotFoundException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/** The History page's store: every message sent from Compose, by email or WhatsApp. */
@Service
public class SentMessageService {

    private static final Logger log = LoggerFactory.getLogger(SentMessageService.class);

    /** The page shows the most recent sends; a year of daily applications fits comfortably. */
    static final int MAX_LIST = 1000;

    private final SentMessageRepository repo;

    public SentMessageService(SentMessageRepository repo) {
        this.repo = repo;
    }

    /**
     * Record a send. It never throws: a history row that fails to save must not turn a delivered
     * email into an error the user retries — that would send it twice. Not @Transactional on
     * purpose: a failed save inside a wrapping transaction would mark it rollback-only and throw
     * on commit, outside this catch. Callers are not transactional; save() commits on its own.
     */
    public SentMessage record(SentMessage m) {
        try {
            m.setUserId(UserContext.require());
            m.setCompany(clip(m.getCompany(), 255));
            m.setRoleTitle(clip(m.getRoleTitle(), 255));
            m.setRecipient(clip(m.getRecipient() == null ? "" : m.getRecipient(), 255));
            m.setSubject(clip(m.getSubject(), 500));
            m.setResumeName(clip(m.getResumeName(), 255));
            return repo.save(m);
        } catch (RuntimeException e) {
            log.warn("history: could not record a {} {} to {}: {}", m.getChannel(), m.getStatus(),
                    m.getRecipient(), e.getMessage());
            return m;
        }
    }

    public List<SentMessage> list() {
        return repo.findByUserIdOrderByCreatedAtDesc(UserContext.require(), PageRequest.of(0, MAX_LIST));
    }

    @Transactional
    public void delete(UUID id) {
        repo.delete(repo.findByIdAndUserId(id, UserContext.require())
                .orElseThrow(() -> new NotFoundException("history entry not found")));
    }

    private static String clip(String s, int max) {
        if (s == null) return null;
        String t = s.strip();
        if (t.isEmpty()) return null;
        return t.length() <= max ? t : t.substring(0, max);
    }
}
