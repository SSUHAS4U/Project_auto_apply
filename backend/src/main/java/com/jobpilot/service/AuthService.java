package com.jobpilot.service;

import com.jobpilot.domain.AppUser;
import com.jobpilot.domain.Profile;
import com.jobpilot.repository.*;
import com.jobpilot.security.JwtService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@Service
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private final AppUserRepository users;
    private final ProfileRepository profiles;
    private final ApplicationRepository applications;
    private final SavedJobRepository savedJobs;
    private final NotificationRepository notifications;
    private final JwtService jwt;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public AuthService(AppUserRepository users, ProfileRepository profiles,
                       ApplicationRepository applications, SavedJobRepository savedJobs,
                       NotificationRepository notifications, JwtService jwt) {
        this.users = users;
        this.profiles = profiles;
        this.applications = applications;
        this.savedJobs = savedJobs;
        this.notifications = notifications;
        this.jwt = jwt;
    }

    @Transactional
    public Map<String, Object> register(String email, String password, String fullName) {
        String e = normalize(email);
        if (e.isBlank() || password == null || password.length() < 6) {
            throw new IllegalArgumentException("email and a password of 6+ characters are required");
        }
        if (users.existsByEmailIgnoreCase(e)) {
            throw new IllegalStateException("an account with that email already exists");
        }
        boolean firstUser = users.count() == 0;

        AppUser u = new AppUser();
        u.setEmail(e);
        u.setPasswordHash(encoder.encode(password));
        u.setFullName(fullName);
        u = users.saveAndFlush(u); // flush so FK references resolve in the bulk claim updates below

        if (firstUser) {
            // Adopt any pre-existing single-user data so the owner keeps it.
            int p = profiles.claimOrphans(u.getId());
            applications.claimOrphans(u.getId());
            savedJobs.claimOrphans(u.getId());
            notifications.claimOrphans(u.getId());
            log.info("First user '{}' claimed {} orphan profile(s)", e, p);
        }
        // Ensure the user has a profile.
        if (profiles.findByUserId(u.getId()).isEmpty()) {
            Profile prof = new Profile();
            prof.setUserId(u.getId());
            prof.setFullName(fullName == null || fullName.isBlank() ? "Your Name" : fullName);
            prof.setEmail(e);
            prof.setUpdatedAt(Instant.now());
            profiles.save(prof);
        }
        return token(u);
    }

    public Map<String, Object> login(String email, String password) {
        AppUser u = users.findByEmailIgnoreCase(normalize(email))
                .orElseThrow(() -> new IllegalArgumentException("invalid email or password"));
        if (!encoder.matches(password == null ? "" : password, u.getPasswordHash())) {
            throw new IllegalArgumentException("invalid email or password");
        }
        return token(u);
    }

    public Map<String, Object> me(UUID userId) {
        AppUser u = users.findById(userId).orElseThrow(() -> new NotFoundException("user not found"));
        return Map.of("id", u.getId().toString(), "email", u.getEmail(),
                "fullName", u.getFullName() == null ? "" : u.getFullName());
    }

    private Map<String, Object> token(AppUser u) {
        return Map.of(
                "token", jwt.issue(u.getId(), u.getEmail()),
                "user", Map.of("id", u.getId().toString(), "email", u.getEmail(),
                        "fullName", u.getFullName() == null ? "" : u.getFullName()));
    }

    private String normalize(String email) {
        return email == null ? "" : email.trim().toLowerCase();
    }
}
