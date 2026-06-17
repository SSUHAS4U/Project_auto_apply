package com.jobpilot.web;

import com.jobpilot.domain.Notification;
import com.jobpilot.service.NotificationService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/notifications")
public class NotificationController {

    private final NotificationService service;

    public NotificationController(NotificationService service) {
        this.service = service;
    }

    @GetMapping
    public Map<String, Object> list(@RequestParam(required = false, defaultValue = "false") boolean unread) {
        List<Notification> items = service.list(unread);
        return Map.of("items", items, "unreadCount", service.unreadCount());
    }

    @PostMapping("/{id}/read")
    public Map<String, Object> markRead(@PathVariable UUID id) {
        service.markRead(id);
        return Map.of("ok", true);
    }
}
