package com.jobpilot.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

@Getter
@Setter
@Entity
@Table(name = "app_user")
public class AppUser {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false, unique = true)
    private String email;

    @Column(name = "password_hash", nullable = false)
    private String passwordHash;

    @Column(name = "full_name")
    private String fullName;

    /** USER or ADMIN. Authoritative authorization source — checked server-side, never from a token. */
    @Column(nullable = false)
    private String role = "USER";

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();

    public boolean isAdmin() {
        return "ADMIN".equalsIgnoreCase(role);
    }
}
