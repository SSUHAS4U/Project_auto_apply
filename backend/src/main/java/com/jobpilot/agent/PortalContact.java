package com.jobpilot.agent;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** A recruiter / hiring contact discovered on a portal — the Network CRM. */
@Getter
@Setter
@Entity
@Table(name = "portal_contact")
public class PortalContact {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    private String portal;

    private String name;

    @Column(name = "profile_url")
    private String profileUrl;

    private String company;
    private String role;

    @Column(name = "source_job_url")
    private String sourceJobUrl;

    /** none | pending | connected | replied */
    @Column(name = "connection_status", nullable = false)
    private String connectionStatus = "none";

    @Column(name = "last_message_at")
    private Instant lastMessageAt;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
