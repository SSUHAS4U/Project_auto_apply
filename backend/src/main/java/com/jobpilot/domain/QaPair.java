package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** A saved application question→answer the extension can reuse for autofill. */
@Getter
@Setter
@Entity
@Table(name = "qa_pair")
public class QaPair {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id")
    private UUID userId;

    @Column(nullable = false)
    private String question;

    @Column(name = "question_key", nullable = false)
    private String questionKey;

    @Column(nullable = false)
    private String answer;

    private String source = "manual";

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
