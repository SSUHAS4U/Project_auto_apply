package com.jobpilot.service;

import com.jobpilot.domain.AppUser;
import com.jobpilot.repository.*;
import com.jobpilot.security.UserContext;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Admin-only user management. All entry points run behind an ADMIN-role check in AuthFilter. */
@Service
public class AdminService {

    private final AppUserRepository users;
    private final ApplicationRepository applications;
    private final SavedJobRepository savedJobs;
    private final ProfileRepository profiles;

    public AdminService(AppUserRepository users, ApplicationRepository applications,
                        SavedJobRepository savedJobs, ProfileRepository profiles) {
        this.users = users;
        this.applications = applications;
        this.savedJobs = savedJobs;
        this.profiles = profiles;
    }

    /** Full detail for the admin "view user" panel: account + profile snapshot + counts. */
    public Map<String, Object> userDetail(UUID id) {
        AppUser u = users.findById(id).orElseThrow(() -> new NotFoundException("user not found"));
        Map<String, Object> m = new LinkedHashMap<>(toDto(u));
        profiles.findByUserId(id).ifPresent(p -> {
            m.put("phone", p.getPhone());
            m.put("location", p.getLocation());
            m.put("headline", p.getHeadline());
            m.put("currentTitle", p.getCurrentTitle());
            m.put("currentCompany", p.getCurrentCompany());
            m.put("yearsExperience", p.getYearsExperience());
            m.put("skills", p.getSkills());
            m.put("summary", p.getSummary());
            m.put("resumeFilename", p.getResumeFilename());
        });
        return m;
    }

    public List<Map<String, Object>> listUsers(String query) {
        String q = query == null ? "" : query.trim().toLowerCase();
        List<AppUser> list = q.isBlank() ? users.findAllByOrderByCreatedAtAsc() : users.search(q);
        return list.stream().map(this::toDto).toList();
    }

    @Transactional
    public void deleteUser(UUID targetId) {
        UUID me = UserContext.require();
        if (me.equals(targetId)) {
            throw new IllegalStateException("You can't delete your own admin account.");
        }
        AppUser target = users.findById(targetId)
                .orElseThrow(() -> new NotFoundException("user not found"));
        users.delete(target); // child rows (profile/application/saved_job/notification/qa_pair) cascade
    }

    @Transactional
    public Map<String, Object> setRole(UUID targetId, String role) {
        String r = role == null ? "" : role.trim().toUpperCase();
        if (!r.equals("ADMIN") && !r.equals("USER")) {
            throw new IllegalArgumentException("role must be ADMIN or USER");
        }
        UUID me = UserContext.require();
        if (me.equals(targetId) && r.equals("USER")) {
            throw new IllegalStateException("You can't revoke your own admin access.");
        }
        AppUser u = users.findById(targetId)
                .orElseThrow(() -> new NotFoundException("user not found"));
        u.setRole(r);
        users.save(u);
        return toDto(u);
    }

    private Map<String, Object> toDto(AppUser u) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", u.getId().toString());
        m.put("email", u.getEmail());
        m.put("fullName", u.getFullName() == null ? "" : u.getFullName());
        m.put("role", u.getRole() == null ? "USER" : u.getRole());
        m.put("isAdmin", u.isAdmin());
        m.put("createdAt", u.getCreatedAt() == null ? null : u.getCreatedAt().toString());
        m.put("applications", applications.countByUserId(u.getId()));
        m.put("savedJobs", savedJobs.countByUserId(u.getId()));
        return m;
    }
}
