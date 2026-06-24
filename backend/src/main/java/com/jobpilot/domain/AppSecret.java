package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;

/** An encrypted secret (API key) managed from the Admin UI. value_enc never holds plaintext. */
@Getter
@Setter
@Entity
@Table(name = "app_secret")
public class AppSecret {

    @Id
    @Column(name = "name")
    private String name;

    @Column(name = "value_enc", nullable = false)
    private String valueEnc;

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
