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

    /**
     * "Connected, but nobody has confirmed it lately." Derived on read, never stored — the
     * moment the worker reports again this is recomputed from scratch, so it cannot get
     * stuck on the way a persisted flag could.
     *
     * Kept separate from `status` on purpose. Downgrading an unconfirmed session straight to
     * "disconnected" would tell owners with a perfectly live session to go and log in again.
     * This says exactly what is known: it worked at {@link #staleSince}, and has not been
     * checked since.
     */
    @Transient
    private boolean stale;

    /** When the session was last actually confirmed. Only set when {@link #stale}. */
    @Transient
    private Instant staleSince;
}
