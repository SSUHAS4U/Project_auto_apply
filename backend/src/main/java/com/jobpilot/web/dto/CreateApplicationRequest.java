package com.jobpilot.web.dto;

import java.util.UUID;

public record CreateApplicationRequest(UUID jobId, String status, String notes) {}
