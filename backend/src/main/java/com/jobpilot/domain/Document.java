package com.jobpilot.domain;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** A user-uploaded document. {@code data} is AES-GCM encrypted at rest. */
@Getter
@Setter
@Entity
@Table(name = "document")
public class Document {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id")
    private UUID userId;

    @Column(nullable = false)
    private String name;

    @Column(name = "doc_type", nullable = false)
    private String docType = "other";

    private String filename;

    @Column(name = "content_type")
    private String contentType;

    @Column(name = "size_bytes")
    private Long sizeBytes;

    /** Encrypted bytes — never serialized to JSON. */
    @JsonIgnore
    @Column(nullable = false)
    private byte[] data;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();
}
