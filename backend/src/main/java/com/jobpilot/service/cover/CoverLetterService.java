package com.jobpilot.service.cover;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Selects the configured provider; falls back to the template on any failure. */
@Service
public class CoverLetterService {

    private static final Logger log = LoggerFactory.getLogger(CoverLetterService.class);

    private final Map<String, CoverLetterProvider> providers;
    private final TemplateCoverLetterProvider template;
    private final JobPilotProperties props;

    public CoverLetterService(List<CoverLetterProvider> providerList,
                              TemplateCoverLetterProvider template,
                              JobPilotProperties props) {
        this.providers = providerList.stream()
                .collect(Collectors.toMap(CoverLetterProvider::name, Function.identity()));
        this.template = template;
        this.props = props;
    }

    public String generate(Job job, Profile profile) {
        String configured = props.getCoverletter().getProvider();
        CoverLetterProvider p = providers.getOrDefault(configured, template);
        try {
            String letter = p.generate(job, profile);
            if (letter == null || letter.isBlank()) throw new IllegalStateException("empty letter");
            return letter;
        } catch (Exception e) {
            log.warn("Cover-letter provider '{}' failed ({}); using template fallback",
                    configured, e.getMessage());
            return template.generate(job, profile);
        }
    }
}
