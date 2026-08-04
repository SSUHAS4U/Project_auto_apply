package com.jobpilot.agent;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/** One outreach attempt — the record the throttles and the idempotency check are built on. */
@Entity
@Table(name = "outreach_log")
public class OutreachLog {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    private String portal;

    /** Lower-cased for comparison. */
    private String company;

    @Column(name = "role_title")
    private String roleTitle;

    @Column(name = "recruiter_url")
    private String recruiterUrl;

    @Column(name = "recruiter_name")
    private String recruiterName;

    /** Recruiter's email when we have it — the other half of "is this the same person?". */
    private String email;

    /** How we reached them: "email" or "message". */
    private String channel;

    @Column(name = "outreach_hash", nullable = false)
    private String outreachHash;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getUserId() { return userId; }
    public void setUserId(UUID userId) { this.userId = userId; }
    public String getPortal() { return portal; }
    public void setPortal(String portal) { this.portal = portal; }
    public String getCompany() { return company; }
    public void setCompany(String company) { this.company = company; }
    public String getRoleTitle() { return roleTitle; }
    public void setRoleTitle(String roleTitle) { this.roleTitle = roleTitle; }
    public String getRecruiterUrl() { return recruiterUrl; }
    public void setRecruiterUrl(String recruiterUrl) { this.recruiterUrl = recruiterUrl; }
    public String getRecruiterName() { return recruiterName; }
    public void setRecruiterName(String recruiterName) { this.recruiterName = recruiterName; }
    public String getOutreachHash() { return outreachHash; }
    public void setOutreachHash(String outreachHash) { this.outreachHash = outreachHash; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getChannel() { return channel; }
    public void setChannel(String channel) { this.channel = channel; }
}
