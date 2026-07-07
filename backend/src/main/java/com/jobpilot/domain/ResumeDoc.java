package com.jobpilot.domain;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** A named, editable LaTeX resume (Overleaf-style) compiled to PDF on demand. */
@Getter
@Setter
@Entity
@Table(name = "resume_doc")
public class ResumeDoc {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false, columnDefinition = "text")
    private String latex = "";

    /** Last compiled PDF (null until first successful compile). Not serialized. */
    @JsonIgnore
    @Column(columnDefinition = "bytea")
    private byte[] pdf;

    /** The base/original resume — tailored copies duplicate from this one. */
    @Column(name = "is_base", nullable = false)
    private boolean base = false;

    /** When tailored to a JD: the job posting URL and captured JD text. */
    @Column(name = "job_url")
    private String jobUrl;

    @JsonIgnore
    @Column(name = "jd_text", columnDefinition = "text")
    private String jdText;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    /** Serialized flag for the UI/extension: is a compiled PDF available? */
    @Transient
    public boolean isHasPdf() {
        return pdf != null && pdf.length > 0;
    }
}
