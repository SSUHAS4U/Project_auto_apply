package com.jobpilot.agent;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/**
 * Connection status for one portal. The real "connection" is the worker's logged-in
 * browser session on the owner's PC; this row just tracks its status for the dashboard
 * plus a pending connect/disconnect action the worker picks up.
 */
@Getter
@Setter
@Entity
@Table(name = "portal_connection")
public class PortalConnection {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    private String portal;

    /** connected | connecting | disconnected */
    @Column(nullable = false)
    private String status = "disconnected";

    /** connect | disconnect — set by the dashboard, consumed by the worker. */
    @Column(name = "requested_action")
    private String requestedAction;

    private String detail;

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
