package com.jobpilot.connector;

import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/** Source-agnostic job as returned by a connector, before normalization. */
@Data
@Builder
public class RawJob {
    private String source;
    private String sourceJobId;
    private String title;
    private String company;
    private String location;
    private boolean remote;
    private String description;
    private String url;
    /** email | url | ats | unknown */
    private String applyType;
    private String applyEmail;
    private String salaryText;
    private Instant postedAt;
    /** Raw provider payload as JSON string (stored for debugging/audit). */
    private String raw;
}
