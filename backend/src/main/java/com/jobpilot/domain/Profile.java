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

    @Column(name = "user_id")
    private UUID userId;

    // --- Personal -----------------------------------------------------------
    @Column(name = "full_name", nullable = false)
    private String fullName;

    @Column(name = "first_name")
    private String firstName;

    @Column(name = "last_name")
    private String lastName;

    @Column(nullable = false)
    private String email;

    private String phone;
    private String headline;

    @Column(columnDefinition = "text")
    private String summary;

    private String location;

    /** Secondary location — e.g. home town / preferred relocation city. */
    @Column(name = "location2")
    private String location2;

    private String address;
    private String city;
    private String state;
    private String country;

    @Column(name = "postal_code")
    private String postalCode;

    @Column(name = "date_of_birth")
    private String dateOfBirth;

    private String gender;
    private String nationality;

    // --- Professional -------------------------------------------------------
    private String seniority;

    @Column(name = "current_title")
    private String currentTitle;

    @Column(name = "current_company")
    private String currentCompany;

    @Column(name = "years_experience")
    private String yearsExperience;

    @Column(name = "current_ctc")
    private String currentCtc;

    @Column(name = "expected_ctc")
    private String expectedCtc;

    @Column(name = "notice_period")
    private String noticePeriod;

    @Column(name = "available_from")
    private String availableFrom;

    @Column(name = "work_authorization")
    private String workAuthorization;

    @Column(name = "requires_sponsorship")
    private Boolean requiresSponsorship;

    @Column(name = "willing_to_relocate")
    private Boolean willingToRelocate;

    @Type(ListArrayType.class)
    @Column(name = "preferred_locations", columnDefinition = "text[]")
    private List<String> preferredLocations = new ArrayList<>();

    @Type(ListArrayType.class)
    @Column(columnDefinition = "text[]")
    private List<String> languages = new ArrayList<>();

    @Type(ListArrayType.class)
    @Column(columnDefinition = "text[]")
    private List<String> skills = new ArrayList<>();

    // --- Structured ---------------------------------------------------------
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<Map<String, Object>> experience = new ArrayList<>();

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<Map<String, Object>> education = new ArrayList<>();

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<Map<String, Object>> certifications = new ArrayList<>();

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private Map<String, String> links = new LinkedHashMap<>();

    /** Custom label -> value answers the extension uses for arbitrary questions. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "field_map", columnDefinition = "jsonb")
    private Map<String, String> fieldMap = new LinkedHashMap<>();

    @Column(name = "cover_letter_template", columnDefinition = "text")
    private String coverLetterTemplate;

    @Column(name = "email_template", columnDefinition = "text")
    private String emailTemplate;

    // --- Resume -------------------------------------------------------------
    @Column(name = "resume_path")
    private String resumePath;

    @Column(name = "resume_filename")
    private String resumeFilename;

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
