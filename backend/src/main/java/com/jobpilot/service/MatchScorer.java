package com.jobpilot.service;

import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;

public interface MatchScorer {
    /** Returns a 0..100 fit score for the job against the owner profile. */
    int score(Job job, Profile profile);
}
