package com.jobpilot.config;

import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;

import java.io.InputStream;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * `application.yml` must parse the way SPRING will parse it.
 *
 * <h2>The outage this exists to prevent</h2>
 *
 * On 2026-09-19 a second {@code jooble:} block was added to a file that already had one. The
 * result was not a warning or a last-one-wins merge — Spring Boot's SnakeYAML rejects duplicate
 * keys outright, so the environment never loaded, the context never started, and every request
 * 502'd. The container stayed "Up", so the deploy reported success over a dead backend.
 *
 * Nothing caught it earlier because nothing READ this file outside a running application. The
 * unit tests do not boot a context, and a local check with PyYAML passed — PyYAML silently
 * keeps the last duplicate, which is the opposite of what production does. A validator that is
 * more permissive than production is worse than none: it grants confidence it has not earned.
 *
 * This loads the real file with {@code allowDuplicateKeys(false)}, which is precisely Spring
 * Boot's setting, so a duplicate fails the build in a second instead of taking the site down.
 */
class ApplicationYamlTest {

    private Map<String, Object> load(String resource) throws Exception {
        LoaderOptions opts = new LoaderOptions();
        // The one line that matters: Spring Boot's OriginTrackedYamlLoader sets this too.
        opts.setAllowDuplicateKeys(false);
        Yaml yaml = new Yaml(new SafeConstructor(opts));
        try (InputStream in = getClass().getClassLoader().getResourceAsStream(resource)) {
            assertNotNull(in, resource + " is missing from the classpath");
            return yaml.load(in);
        }
    }

    @Test
    void applicationYamlParsesWithNoDuplicateKeys() throws Exception {
        Map<String, Object> root = assertDoesNotThrow(() -> load("application.yml"),
                "application.yml has a duplicate key — Spring refuses to start on this, "
                        + "and the container stays up while every request 502s");
        assertTrue(root.containsKey("jobpilot"), "the jobpilot config block vanished");
    }

    /**
     * Every aggregator the scout declares as a channel needs its config block present, or the
     * connector silently reports itself unconfigured forever — which is the failure mode that
     * hid Jooble for months.
     */
    @Test
    @SuppressWarnings("unchecked")
    void everyAggregatorChannelHasItsConfigBlock() throws Exception {
        Map<String, Object> jp = (Map<String, Object>) load("application.yml").get("jobpilot");
        for (String channel : new String[] { "jooble", "careerjet" }) {
            assertTrue(jp.containsKey(channel),
                    "jobpilot." + channel + " config block is missing — JobScoutService lists it "
                            + "as an expected channel, so it must be configurable");
        }
    }
}
