package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/**
 * One message the user sent (or tried to) from Compose — the History page. V40.
 *
 * Deliberately separate from {@code outreach_log}, the auto-apply agent's anti-spam ledger:
 * that one refuses a repeat by design and keeps no text; this one is a record for a person.
 */
@Getter
@Setter
@Entity
@Table(name = "sent_message")
public class SentMessage {

    public static final String EMAIL = "EMAIL";
    public static final String WHATSAPP = "WHATSAPP";

    /** The mail server accepted it. */
    public static final String SENT = "SENT";
    /** It did not go out; {@link #error} says why. */
    public static final String FAILED = "FAILED";
    /** Handed to WhatsApp with the text filled in — the user presses Send there, so JobPilot
     *  cannot confirm delivery and never claims it. */
    public static final String OPENED = "OPENED";

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    private String channel;

    @Column(nullable = false)
    private String status;

    private String company;

    @Column(name = "role_title")
    private String roleTitle;

    @Column(nullable = false)
    private String recipient;

    private String subject;

    @Column(columnDefinition = "text")
    private String body;

    @Column(name = "cover_letter", columnDefinition = "text")
    private String coverLetter;

    @Column(name = "resume_name")
    private String resumeName;

    @Column(name = "cover_attached", nullable = false)
    private boolean coverAttached;

    @Column(name = "resume_attached", nullable = false)
    private boolean resumeAttached;

    @Column(columnDefinition = "text")
    private String error;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();
}
