package com.jobpilot.domain;

import io.hypersistence.utils.hibernate.type.array.ListArrayType;
import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.Type;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Getter
@Setter
@Entity
@Table(name = "profile")
public class Profile {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "full_name", nullable = false)
    private String fullName;

    @Column(nullable = false)
    private String email;

    private String phone;
    private String location;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private Map<String, String> links = new LinkedHashMap<>();

    @Type(ListArrayType.class)
    @Column(columnDefinition = "text[]")
    private List<String> skills = new ArrayList<>();

    private String seniority;

    /** Opaque JSON passthrough of structured work history. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private String experience = "[]";

    @Column(name = "resume_path")
    private String resumePath;

    @Column(name = "resume_filename")
    private String resumeFilename;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "field_map", columnDefinition = "jsonb")
    private Map<String, String> fieldMap = new LinkedHashMap<>();

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
