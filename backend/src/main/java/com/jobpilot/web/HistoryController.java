package com.jobpilot.web;

import com.jobpilot.domain.SentMessage;
import com.jobpilot.service.mail.SentMessageService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Documents → History: what was sent from Compose, to whom, by which channel. */
@RestController
@RequestMapping("/api/history")
public class HistoryController {

    private final SentMessageService history;

    public HistoryController(SentMessageService history) {
        this.history = history;
    }

    @GetMapping
    public List<SentMessage> list() {
        return history.list();
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable UUID id) {
        history.delete(id);
        return Map.of("deleted", true);
    }
}
