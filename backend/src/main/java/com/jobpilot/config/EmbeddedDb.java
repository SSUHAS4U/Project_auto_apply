package com.jobpilot.config;

import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;

/**
 * Optional zero-Docker local database. When {@code JOBPILOT_EMBEDDED_DB=true},
 * boots an in-process Postgres before Spring starts and points the datasource at
 * it via system properties (which outrank OS env vars in Spring's property order).
 * Does nothing in production where the flag is unset.
 */
public final class EmbeddedDb {

    private EmbeddedDb() {}

    public static void startIfEnabled() {
        if (!"true".equalsIgnoreCase(System.getenv("JOBPILOT_EMBEDDED_DB"))) {
            return;
        }
        try {
            int port = Integer.parseInt(System.getenv().getOrDefault("JOBPILOT_EMBEDDED_DB_PORT", "5432"));
            // Persist data across restarts (fixed dir, not cleaned) so dev data survives.
            java.io.File dataDir = new java.io.File(
                    System.getenv().getOrDefault("JOBPILOT_EMBEDDED_DB_DIR", "./.embedded-pg")).getAbsoluteFile();
            EmbeddedPostgres pg = EmbeddedPostgres.builder()
                    .setPort(port)
                    .setDataDirectory(dataDir)
                    .setCleanDataDirectory(false)
                    .start();
            String url = "jdbc:postgresql://localhost:" + port + "/postgres";
            System.setProperty("spring.datasource.url", url);
            System.setProperty("spring.datasource.username", "postgres");
            System.setProperty("spring.datasource.password", "postgres");
            // Keep a reference so the JVM doesn't GC/stop the instance.
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                try { pg.close(); } catch (Exception ignored) { }
            }));
            System.out.println("[JobPilot] Embedded Postgres started at " + url);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to start embedded Postgres: " + e.getMessage(), e);
        }
    }
}
