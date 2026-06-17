package com.jobpilot.connector;

import java.util.List;

/** A single legal, free job source. */
public interface JobConnector {

    /** Stable source key, e.g. "greenhouse", "adzuna". */
    String source();

    /** True if the connector has the credentials/config it needs to run. */
    default boolean isConfigured() {
        return true;
    }

    /**
     * ATS connectors (greenhouse/lever/ashby) are driven per-board from the
     * ats_source table; aggregator connectors (adzuna/jooble) run from config.
     */
    default boolean isPerBoard() {
        return false;
    }

    List<RawJob> fetch(FetchParams p) throws ConnectorException;
}
