package com.jobpilot.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.domain.AppUser;
import com.jobpilot.domain.Notification;
import com.jobpilot.repository.AppUserRepository;
import com.jobpilot.repository.NotificationRepository;
import com.jobpilot.security.UserContext;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class NotificationService {

    private final NotificationRepository repo;
    private final AppUserRepository users;
    private final ObjectMapper mapper = new ObjectMapper();

    public NotificationService(NotificationRepository repo, AppUserRepository users) {
        this.repo = repo;
        this.users = users;
    }

    // ---- User-facing (JWT context) ----
    public List<Notification> list(boolean unreadOnly) {
        UUID userId = UserContext.require();
        return unreadOnly ? repo.findByUserIdAndReadFalseOrderByCreatedAtDesc(userId)
                : repo.findByUserIdOrderByCreatedAtDesc(userId);
    }

    public long unreadCount() {
        return repo.countByUserIdAndReadFalse(UserContext.require());
    }

    @Transactional
    public void markRead(UUID id) {
        UUID userId = UserContext.require();
        repo.findById(id).filter(n -> userId.equals(n.getUserId())).ifPresent(n -> {
            n.setRead(true);
            repo.save(n);
        });
    }

    // ---- Cron/admin: notifications go to the owner (first user) ----
    @Transactional
    public Notification create(String type, String title, String body, Map<String, Object> payload) {
        UUID owner = users.findAll(PageRequest.of(0, 1)).stream().findFirst().map(AppUser::getId).orElse(null);
        return create(owner, type, title, body, payload);
    }

    @Transactional
    public Notification create(UUID userId, String type, String title, String body, Map<String, Object> payload) {
        Notification n = new Notification();
        n.setUserId(userId);
        n.setType(type);
        n.setTitle(title);
        n.setBody(body);
        try {
            n.setPayload(payload == null ? "{}" : mapper.writeValueAsString(payload));
        } catch (Exception e) {
            n.setPayload("{}");
        }
        return repo.save(n);
    }
}
