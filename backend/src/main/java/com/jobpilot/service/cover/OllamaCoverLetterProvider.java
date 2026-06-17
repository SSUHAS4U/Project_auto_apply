package com.jobpilot.service.cover;

import com.fasterxml.jackson.databind.JsonNode;
import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.Map;

/** Default LLM provider: local Ollama at /api/generate. */
@Component
public class OllamaCoverLetterProvider implements CoverLetterProvider {

    private final JobPilotProperties props;
    private final RestClient http;

    public OllamaCoverLetterProvider(JobPilotProperties props, RestClient http) {
        this.props = props;
        this.http = http;
    }

    @Override
    public String name() {
        return "ollama";
    }

    @Override
    public String generate(Job job, Profile profile) {
        String url = props.getOllama().getUrl() + "/api/generate";
        Map<String, Object> body = Map.of(
                "model", props.getOllama().getModel(),
                "prompt", CoverLetterPrompt.build(job, profile),
                "stream", false,
                "options", Map.of("temperature", 0.6));
        JsonNode resp = http.post().uri(url)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(JsonNode.class);
        if (resp == null || !resp.has("response")) {
            throw new IllegalStateException("ollama returned no response");
        }
        return resp.get("response").asText().strip();
    }
}
