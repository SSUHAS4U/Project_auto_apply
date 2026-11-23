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

    /** The file that gets sent: the last compiled PDF of a built résumé (null until the first
     *  compile), or the uploaded file itself — which may be a DOCX, see {@link #contentType}.
     *  Not serialized. */
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

    /** What the AI changed (and which JD requirement each change serves) when tailoring. */
    @Column(name = "tailor_notes", columnDefinition = "text")
    private String tailorNotes;

    /** The role this résumé targets ("Backend Engineer"), so the right one can be picked per job. */
    private String role;

    /** {@code built} (LaTeX, compiled on demand) or {@code uploaded} (a file used as-is). */
    @Column(nullable = false)
    private String source = SOURCE_BUILT;

    /** Original filename of an uploaded résumé; null for built ones. */
    private String filename;

    /** MIME type of {@link #pdf}. Null means application/pdf (every built résumé). */
    @Column(name = "content_type")
    private String contentType;

    /** The library default — copied into profile.resume_data for the worker and extension. */
    @Column(name = "is_default", nullable = false)
    private boolean defaultResume = false;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    public static final String SOURCE_BUILT = "built";
    public static final String SOURCE_UPLOADED = "uploaded";

    @Transient
    public boolean isUploaded() {
        return SOURCE_UPLOADED.equals(source);
    }

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    /** Serialized flag for the UI/extension: is a compiled PDF available? */
    @Transient
    public boolean isHasPdf() {
        return pdf != null && pdf.length > 0;
    }
}
