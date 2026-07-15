package com.jobpilot.agent;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** Latest live screenshot for a user's Watch Live panel (one row, upserted ~1/sec). */
@Getter
@Setter
@Entity
@Table(name = "live_frame")
public class LiveFrame {

    @Id
    @Column(name = "user_id")
    private UUID userId;

    @Column(name = "run_id")
    private UUID runId;

    private String portal;

    private String action;

    /** Downscaled JPEG, base64-encoded. */
    @Column(name = "image_b64", columnDefinition = "text")
    private String imageB64;

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
