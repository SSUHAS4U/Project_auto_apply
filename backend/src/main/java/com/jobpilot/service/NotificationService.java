package com.jobpilot.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jobpilot.domain.Notification;
import com.jobpilot.repository.NotificationRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class NotificationService {

    private final NotificationRepository repo;
    private final ObjectMapper mapper = new ObjectMapper();

    public NotificationService(NotificationRepository repo) {
        this.repo = repo;
    }

    public List<Notification> list(boolean unreadOnly) {
        return unreadOnly ? repo.findByReadFalseOrderByCreatedAtDesc()
                : repo.findAllByOrderByCreatedAtDesc();
    }

    public long unreadCount() {
        return repo.countByReadFalse();
    }

    @Transactional
    public Notification create(String type, String title, String body, Map<String, Object> payload) {
        Notification n = new Notification();
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

    @Transactional
    public void markRead(UUID id) {
        repo.findById(id).ifPresent(n -> {
            n.setRead(true);
            repo.save(n);
        });
    }
}
