package com.jobpilot.service;

import com.jobpilot.config.JobPilotProperties;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;

/**
 * Stores the owner's resume on local disk (outside the repo). Phase 2 default;
 * can later be swapped for a Supabase private storage bucket behind this same API.
 */
@Service
public class ResumeStorageService {

    private final Path dir;

    public ResumeStorageService(JobPilotProperties props) {
        this.dir = Paths.get(props.getResumeDir()).toAbsolutePath().normalize();
    }

    public Stored store(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("resume file is empty");
        }
        String original = file.getOriginalFilename() == null ? "resume.pdf" : file.getOriginalFilename();
        String safe = original.replaceAll("[^A-Za-z0-9._-]", "_");
        try {
            Files.createDirectories(dir);
            Path target = dir.resolve("resume_" + System.currentTimeMillis() + "_" + safe);
            try (InputStream in = file.getInputStream()) {
                Files.copy(in, target, StandardCopyOption.REPLACE_EXISTING);
            }
            return new Stored(target.toString(), original);
        } catch (IOException e) {
            throw new IllegalStateException("failed to store resume: " + e.getMessage(), e);
        }
    }

    public Path resolve(String storedPath) {
        return Paths.get(storedPath);
    }

    public boolean exists(String storedPath) {
        return storedPath != null && Files.exists(Paths.get(storedPath));
    }

    public record Stored(String path, String filename) {}
}
