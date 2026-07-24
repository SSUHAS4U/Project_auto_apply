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

    @Column(name = "middle_name")
    private String middleName;

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

    // --- Second / permanent address ---
    private String address2;
    private String city2;
    private String state2;
    private String country2;

    @Column(name = "postal_code2")
    private String postalCode2;

    @Column(name = "date_of_birth")
    private String dateOfBirth;

    @Column(name = "alternate_phone")
    private String alternatePhone;

    @Column(name = "marital_status")
    private String maritalStatus;

    /** Asked on many Indian application forms. */
    @Column(name = "father_name")
    private String fatherName;

    @Column(name = "disability_status")
    private String disabilityStatus;

    private String gender;
    private String nationality;

    // --- Extras many Indian application forms require -----------------------
    @Column(name = "open_to_shifts")
    private String openToShifts;          // "yes" / "no" / blank

    @Column(name = "leetcode_url")
    private String leetcodeUrl;
    @Column(name = "leetcode_score")
    private String leetcodeScore;
    @Column(name = "codechef_url")
    private String codechefUrl;
    @Column(name = "codechef_score")
    private String codechefScore;
    @Column(name = "codeforces_url")
    private String codeforcesUrl;
    @Column(name = "codeforces_score")
    private String codeforcesScore;
    @Column(name = "laptop_config")
    private String laptopConfig;

    // --- Job profile (what the candidate hunts for + showcase material) ------
    @Column(name = "desired_titles")
    private String desiredTitles;         // comma-separated, feeds search keywords

    @Column(name = "experience_level")
    private String experienceLevel;       // e.g. "0-2 Years"

    @Column(name = "job_type")
    private String jobType;               // e.g. "Full-time"

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<Map<String, Object>> projects = new ArrayList<>();

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<Map<String, Object>> achievements = new ArrayList<>();

    // --- Professional -------------------------------------------------------
    private String seniority;

    @Column(name = "current_title")
    private String currentTitle;

    @Column(name = "current_company")
    private String currentCompany;

    @Column(name = "years_experience")
    private String yearsExperience;

    @Column(name = "college")
    private String college;

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

    // ---- Easy-Apply autofill answers (all optional) -------------------------
    @Column(name = "phone_country_code")
    private String phoneCountryCode;      // e.g. "+91"
    @Column(name = "willing_remote")
    private Boolean willingRemote;
    @Column(name = "willing_onsite")
    private Boolean willingOnsite;
    @Column(name = "security_clearance")
    private Boolean securityClearance;
    @Column(name = "highest_education")
    private String highestEducation;      // e.g. "B.Tech"
    private String gpa;
    @Column(name = "tier_one_institution")
    private Boolean tierOneInstitution;
    @Column(name = "completed_bachelors")
    private Boolean completedBachelors;
    private String ethnicity;
    @Column(name = "veteran_status")
    private String veteranStatus;
    @Column(name = "hispanic_latino")
    private Boolean hispanicLatino;
    @Column(name = "how_did_you_hear")
    private String howDidYouHear;
    /** Per-skill years, e.g. {"java":"3","react":"1"}. */
    @Column(name = "skills_experience", columnDefinition = "jsonb")
    private Map<String, String> skillsExperience = new LinkedHashMap<>();

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

    /** Resume bytes stored in the DB so they persist across restarts (ephemeral disk safe).
     *  JsonIgnore so the large blob never goes over the wire in the profile API. */
    @com.fasterxml.jackson.annotation.JsonIgnore
    @Column(name = "resume_data")
    private byte[] resumeData;

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();
}
