package com.jobpilot.agent;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

import java.time.Instant;
import java.util.UUID;

/** One thing that happened — the timeline + the source of every dashboard metric. */
@Getter
@Setter
@Entity
@Table(name = "agent_event")
public class AgentEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "run_id")
    private UUID runId;

    @Column(name = "task_id")
    private UUID taskId;

    private String portal;

    /**
     * post_analysed | job_identified | relevant | applied | connection_sent |
     * message_sent | email_sent | reply_received | easy_apply | error | info
     */
    @Column(nullable = false)
    private String type;

    private String title;
    private String company;
    private String url;

    @Column(columnDefinition = "text")
    private String detail;

    @Column(name = "created_at")
    private Instant createdAt = Instant.now();
}
