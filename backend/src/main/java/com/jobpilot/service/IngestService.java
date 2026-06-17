package com.jobpilot.service;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.connector.FetchParams;
import com.jobpilot.connector.JobConnector;
import com.jobpilot.connector.RawJob;
import com.jobpilot.domain.AtsSource;
import com.jobpilot.domain.Job;
import com.jobpilot.domain.Profile;
import com.jobpilot.repository.AtsSourceRepository;
import com.jobpilot.repository.JobRepository;
import com.jobpilot.repository.ProfileRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Orchestrates a full ingest run: ATS connectors are driven per curated board
 * from {@code ats_source}; aggregator connectors run from config queries.
 * Idempotent — upserts on content_hash.
 */
@Service
public class IngestService {

    private static final Logger log = LoggerFactory.getLogger(IngestService.class);

    private final List<JobConnector> connectors;
    private final AtsSourceRepository atsRepo;
    private final JobRepository jobRepo;
    private final ProfileRepository profileRepo;
    private final NormalizeService normalize;
    private final MatchScorer scorer;
    private final JobPilotProperties props;

    public IngestService(List<JobConnector> connectors,
                         AtsSourceRepository atsRepo,
                         JobRepository jobRepo,
                         ProfileRepository profileRepo,
                         NormalizeService normalize,
                         MatchScorer scorer,
                         JobPilotProperties props) {
        this.connectors = connectors;
        this.atsRepo = atsRepo;
        this.jobRepo = jobRepo;
        this.profileRepo = profileRepo;
        this.normalize = normalize;
        this.scorer = scorer;
        this.props = props;
    }

    public IngestResult run() {
        Map<String, JobConnector> byName = connectors.stream()
                .collect(Collectors.toMap(JobConnector::source, c -> c, (a, b) -> a));
        Profile profile = profileRepo.findFirstByOrderByUpdatedAtAsc().orElse(null);

        int fetched = 0, inserted = 0, updated = 0;

        // 1. Per-board ATS connectors from curated ats_source rows.
        for (AtsSource src : atsRepo.findByActiveTrue()) {
            JobConnector c = byName.get(src.getProvider());
            if (c == null) {
                log.warn("No connector for ats_source provider '{}'", src.getProvider());
                continue;
            }
            FetchParams p = FetchParams.builder()
                    .boardToken(src.getBoardToken())
                    .company(src.getCompany())
                    .build();
            List<RawJob> raws = safeFetch(c, p);
            fetched += raws.size();
            for (RawJob r : raws) {
                int code = upsert(r, profile);
                if (code == 1) inserted++; else if (code == 2) updated++;
            }
        }

        // 2. Aggregator connectors (adzuna/jooble) from config queries.
        for (JobConnector c : connectors) {
            if (c.isPerBoard() || !c.isConfigured()) continue;
            for (FetchParams p : queriesFor(c)) {
                List<RawJob> raws = safeFetch(c, p);
                fetched += raws.size();
                for (RawJob r : raws) {
                    int code = upsert(r, profile);
                    if (code == 1) inserted++; else if (code == 2) updated++;
                }
            }
        }

        log.info("Ingest complete: fetched={} inserted={} updated={}", fetched, inserted, updated);
        return new IngestResult(fetched, inserted, updated);
    }

    private List<RawJob> safeFetch(JobConnector c, FetchParams p) {
        try {
            return c.fetch(p);
        } catch (Exception e) {
            log.warn("Connector '{}' failed: {}", c.source(), e.getMessage());
            return List.of();
        }
    }

    private List<FetchParams> queriesFor(JobConnector c) {
        if ("adzuna".equals(c.source())) {
            List<String> qs = props.getAdzuna().getQueries();
            if (qs == null || qs.isEmpty()) return List.of();
            return qs.stream()
                    .map(q -> FetchParams.builder().query(q.trim())
                            .where(props.getAdzuna().getWhere()).maxDaysOld(14).build())
                    .collect(Collectors.toList());
        }
        if ("jooble".equals(c.source())) {
            return List.of(FetchParams.builder()
                    .query(props.getJooble().getKeywords()).build());
        }
        if ("google".equals(c.source())) {
            List<String> qs = props.getGoogleCse().getQueries();
            if (qs == null || qs.isEmpty()) return List.of();
            return qs.stream()
                    .map(q -> FetchParams.builder().query(q.trim()).build())
                    .collect(Collectors.toList());
        }
        return List.of(FetchParams.builder().build());
    }

    /** @return 0 = skipped, 1 = inserted, 2 = updated */
    @Transactional
    protected int upsert(RawJob r, Profile profile) {
        if (r.getTitle() == null || r.getUrl() == null) return 0;
        String hash = normalize.contentHash(r.getCompany(), r.getTitle(), r.getLocation());
        Optional<Job> existing = jobRepo.findByContentHash(hash);
        if (existing.isPresent()) {
            Job j = existing.get();
            normalize.refresh(j, r);
            jobRepo.save(j);
            return 2;
        }
        Job j = normalize.toJob(r);
        if (profile != null) {
            j.setMatchScore(scorer.score(j, profile));
        }
        try {
            jobRepo.save(j);
            return 1;
        } catch (org.springframework.dao.DataIntegrityViolationException dup) {
            // Concurrent insert with same hash — treat as update no-op.
            return 0;
        }
    }

    public record IngestResult(int fetched, int inserted, int updated) {}
}
