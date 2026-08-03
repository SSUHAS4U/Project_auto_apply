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

    /** HR/recruiter email harvested from a hiring post (the lead pipeline). */
    private String email;

    /** none | pending | connected | replied */
    @Column(name = "connection_status", nullable = false)
    private String connectionStatus = "none";

    @Column(name = "last_message_at")
    private Instant lastMessageAt;

    /** Touches SENT so far: 0 = invited only, 1..4 = follow-ups sent, 5 = archived. */
    @Column(name = "follow_up_stage", nullable = false)
    private int followUpStage = 0;

    /** When we last sent this person anything — the clock the cadence counts from. */
    @Column(name = "last_contact_at")
    private Instant lastContactAt;

    /** Set once the sequence is exhausted; an archived contact is never touched again. */
    @Column(name = "archived_at")
    private Instant archivedAt;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();

    public int getFollowUpStage() { return followUpStage; }
    public void setFollowUpStage(int followUpStage) { this.followUpStage = followUpStage; }
    public Instant getLastContactAt() { return lastContactAt; }
    public void setLastContactAt(Instant lastContactAt) { this.lastContactAt = lastContactAt; }
    public Instant getArchivedAt() { return archivedAt; }
    public void setArchivedAt(Instant archivedAt) { this.archivedAt = archivedAt; }
}
