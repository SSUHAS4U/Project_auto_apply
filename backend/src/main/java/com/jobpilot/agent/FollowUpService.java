package com.jobpilot.agent;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.*;

/**
 * The multi-touch follow-up sequence.
 *
 * Outreach used to be invite → accept → one message → silence. Most replies come from the
 * second or third touch, so a single follow-up throws away most of the value of having made
 * the connection at all.
 *
 * The cadence counts days since the LAST touch, not since the invite, so a contact who was
 * reached late doesn't get three messages in one afternoon to "catch up". Once the sequence
 * is exhausted the contact is archived and never touched again — that is what stops this from
 * becoming the thing it is meant to prevent.
 */
@Service
public class FollowUpService {

    /** Fallback spacing when no settings are saved: days to wait before touch N+1. */
    static final int[] DEFAULT_GAP_DAYS = { 1, 2, 5, 10 };
    /** How many touches the sequence has, ever. */
    static final int TOUCHES = DEFAULT_GAP_DAYS.length;

    /** What each touch is FOR. A follow-up that just says "checking in" is why people mute you. */
    private static final String[] ANGLE = {
            // stage 0 → touch 1
            "Introduce yourself in one line and say specifically why your background fits the kind "
            + "of roles they hire for. No ask beyond a brief chat.",
            // stage 1 → touch 2
            "Add ONE concrete piece of evidence — a project, a shipped feature, a measurable result "
            + "— that backs up the fit you claimed. Do not repeat the introduction.",
            // stage 2 → touch 3
            "Ask a direct, easy-to-answer question: whether they have anything open that matches, or "
            + "who would be the right person to speak to.",
            // stage 3 → touch 4
            "Final message. Be gracious, keep it to two sentences, and make it easy to say no — "
            + "offer to stay in touch for future openings rather than pressing.",
    };

    private final PortalContactRepository contacts;
    private final AgentService agent;

    public FollowUpService(PortalContactRepository contacts,
                           @org.springframework.context.annotation.Lazy AgentService agent) {
        this.contacts = contacts;
        this.agent = agent;
    }

    /**
     * The spacing, read from settings so it can be retuned without a rebuild. Falls back to
     * 1/2/5/10 if anything is missing or unreadable — the sequence must always have a shape.
     */
    int[] gapDays() {
        try {
            Map<String, Object> cfg = agent.limits();
            int[] g = new int[TOUCHES];
            for (int i = 0; i < TOUCHES; i++) {
                Object v = cfg.get("followUp" + (i + 1));
                g[i] = v instanceof Number n ? Math.max(0, n.intValue()) : DEFAULT_GAP_DAYS[i];
            }
            return g;
        } catch (Exception e) {
            return DEFAULT_GAP_DAYS.clone();
        }
    }

    /**
     * Contacts whose next touch is due now: connected, not archived, and enough days since the
     * last one. Ordered oldest-first so nobody is starved by a busy day.
     */
    public List<PortalContact> due(UUID userId, Instant now, int limit) {
        List<PortalContact> out = new ArrayList<>();
        // Read the spacing ONCE. isDue() calls gapDays() internally, which rebuilds the whole
        // settings map — doing that per contact meant up to 300 rebuilds for one request.
        int[] gaps = gapDays();
        for (PortalContact c : contacts.findByUserIdAndConnectionStatusOrderByUpdatedAtDesc(
                userId, "connected", PageRequest.of(0, 300))) {
            if (isDue(c, now, gaps)) out.add(c);
        }
        out.sort(Comparator.comparing(c -> c.getLastContactAt() == null ? Instant.EPOCH : c.getLastContactAt()));
        return out.size() > limit ? out.subList(0, limit) : out;
    }

    /** Is this contact's next touch due? */
    boolean isDue(PortalContact c, Instant now) {
        return isDue(c, now, gapDays());
    }

    /** @param gaps the spacing, passed in so a loop reads settings once rather than per contact. */
    boolean isDue(PortalContact c, Instant now, int[] gaps) {
        if (c == null || c.getArchivedAt() != null) return false;
        int stage = c.getFollowUpStage();
        if (stage >= TOUCHES) return false;                   // sequence exhausted
        Instant last = c.getLastContactAt();
        if (last == null) return true;                        // never touched → due immediately
        return !now.isBefore(last.plus(Duration.ofDays(gaps[stage])));
    }

    /** When this contact's next touch falls due, or null once the sequence is over. */
    public Instant nextDueAt(PortalContact c) {
        if (c == null || c.getArchivedAt() != null || c.getFollowUpStage() >= TOUCHES) return null;
        Instant last = c.getLastContactAt();
        return last == null ? Instant.now() : last.plus(Duration.ofDays(gapDays()[c.getFollowUpStage()]));
    }

    /** The instruction that shapes touch N — passed to the message generator. */
    public String angleFor(int stage) {
        return stage >= 0 && stage < ANGLE.length ? ANGLE[stage] : ANGLE[ANGLE.length - 1];
    }

    /** Human label for logs and the dashboard: "follow-up 2 of 4". */
    public String labelFor(int stage) {
        return stage >= TOUCHES ? "final follow-up sent"
                : "follow-up " + (stage + 1) + " of " + TOUCHES;
    }

    /**
     * Record that a touch went out: advance the stage, restart the clock, and archive once the
     * sequence is spent so this contact is never picked up again.
     */
    @Transactional
    public PortalContact recordTouch(UUID userId, UUID contactId, Instant now) {
        PortalContact c = contacts.findById(contactId).orElse(null);
        if (c == null || !c.getUserId().equals(userId)) return null;
        c.setFollowUpStage(c.getFollowUpStage() + 1);
        c.setLastContactAt(now);
        c.setLastMessageAt(now);
        c.setUpdatedAt(now);
        if (c.getFollowUpStage() >= TOUCHES) c.setArchivedAt(now);
        return contacts.save(c);
    }
}
