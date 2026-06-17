package com.jobpilot;

import com.jobpilot.config.EmbeddedDb;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class JobPilotApplication {
    public static void main(String[] args) {
        EmbeddedDb.startIfEnabled();
        SpringApplication.run(JobPilotApplication.class, args);
    }
}
