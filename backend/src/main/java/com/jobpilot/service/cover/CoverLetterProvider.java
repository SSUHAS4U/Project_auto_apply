package com.jobpilot.service.cover;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;

/** Pluggable cover-letter generator. No paid lock-in. */
public interface CoverLetterProvider {
    /** Provider key: ollama | gemini | template. */
    String name();
    String generate(Job job, Profile profile);
}
