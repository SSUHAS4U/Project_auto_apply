package com.jobpilot.agent;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** A message to/from a contact. Recruiter replies are drafted, then owner-approved. */
@Getter
@Setter
@Entity
@Table(name = "agent_message")
public class AgentMessage {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "contact_id")
    private UUID contactId;

    private String portal;

    /** in | out */
    @Column(nullable = false)
    private String direction;

    @Column(columnDefinition = "text")
    private String body;

    /** draft | pending_approval | approved | sent | received */
    @Column(nullable = false)
    private String status = "draft";

    @Column(name = "ai_drafted", nullable = false)
    private boolean aiDrafted;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
