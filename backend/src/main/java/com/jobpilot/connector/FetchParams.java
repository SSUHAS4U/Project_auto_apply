package com.jobpilot.connector;

import lombok.Builder;
import lombok.Data;

/** Optional hints passed to a connector for a fetch (board token, query, etc.). */
@Data
@Builder
public class FetchParams {
    private String boardToken;   // greenhouse/lever/ashby board slug
    private String company;      // display name
    private String query;        // free-text search (adzuna/jooble)
    private String where;        // location filter
    private int maxDaysOld;      // recency window
}
