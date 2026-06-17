package com.jobpilot.web.dto;

public record SavedJobRequest(String title, String company, String location,
                              String url, String sourceSite, String raw) {}
