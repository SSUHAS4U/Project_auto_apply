package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** A link to a résumé or cover letter that a WhatsApp message carries (V40). The token is the
 *  credential; it expires. See {@code service/mail/ShareLinkService}. */
@Getter
@Setter
@Entity
@Table(name = "shared_doc")
public class SharedDoc {

    public static final String RESUME = "RESUME";
    public static final String COVER = "COVER";

    @Id
    private String token;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    private String kind;

    @Column(name = "resume_doc_id")
    private UUID resumeDocId;

    @Column(name = "cover_text", columnDefinition = "text")
    private String coverText;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;
}
