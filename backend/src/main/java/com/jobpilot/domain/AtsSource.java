package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

@Getter
@Setter
@Entity
@Table(name = "ats_source")
public class AtsSource {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    /** greenhouse | lever | ashby */
    @Column(nullable = false)
    private String provider;

    @Column(name = "board_token", nullable = false)
    private String boardToken;

    @Column(nullable = false)
    private String company;

    private boolean active = true;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();
}
