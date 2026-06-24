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

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * Orchestrates a full ingest run: ATS connectors are driven per curated board
 * from {@code ats_source}; aggregator connectors run from config queries.
 * Idempotent — upserts on content_hash.
 */
@Service
public class IngestService {

    private static final Logger log = LoggerFactory.getLogger(IngestService.class);

    /** Don't store dated jobs older than this many days (keeps the board fresh + small). */
    @org.springframework.beans.factory.annotation.Value("${jobpilot.cleanup.retention-days:7}")
    private int maxAgeDays;

    private final List<JobConnector> connectors;
    private final AtsSourceRepository atsRepo;
    private final JobRepository jobRepo;
    private final ProfileRepository profileRepo;
    private final NormalizeService normalize;
    private final MatchScorer scorer;
    private final CleanupService cleanup;
    private final IngestProgress progress;
    private final JobPilotProperties props;

    public IngestService(List<JobConnector> connectors,
                         AtsSourceRepository atsRepo,
                         JobRepository jobRepo,
                         ProfileRepository profileRepo,
                         NormalizeService normalize,
                         MatchScorer scorer,
                         CleanupService cleanup,
                         IngestProgress progress,
                         JobPilotProperties props) {
        this.connectors = connectors;
        this.atsRepo = atsRepo;
        this.jobRepo = jobRepo;
        this.profileRepo = profileRepo;
        this.normalize = normalize;
        this.scorer = scorer;
        this.cleanup = cleanup;
        this.progress = progress;
        this.props = props;
    }

    public IngestResult run() {
        Map<String, JobConnector> byName = connectors.stream()
                .collect(Collectors.toMap(JobConnector::source, c -> c, (a, b) -> a));
        Profile profile = profileRepo.findFirstByOrderByUpdatedAtAsc().orElse(null);

        // Build the full task list (per-board ATS + aggregator queries).
        List<Callable<List<RawJob>>> tasks = new ArrayList<>();
        for (AtsSource src : atsRepo.findByActiveTrue()) {
            JobConnector c = byName.get(src.getProvider());
            if (c == null) {
                log.warn("No connector for ats_source provider '{}'", src.getProvider());
                continue;
            }
            FetchParams p = FetchParams.builder()
                    .boardToken(src.getBoardToken()).company(src.getCompany()).build();
            tasks.add(() -> safeFetch(c, p));
        }
        for (JobConnector c : connectors) {
            if (c.isPerBoard() || !c.isConfigured()) continue;
            for (FetchParams p : queriesFor(c)) {
                tasks.add(() -> safeFetch(c, p));
            }
        }

        // Memory-light: process sources in small WAVES. Each wave fetches a few
        // sources concurrently, upserts them, then releases the memory before the next
        // wave. This bounds heap use (no holding 10k jobs at once → no OOM on 256MB).
        progress.begin(tasks.size());
        int fetched = 0, inserted = 0, updated = 0;
        int wave = Math.max(1, props.getIngestConcurrency());
        ExecutorService pool = Executors.newFixedThreadPool(wave);
        try {
            for (int start = 0; start < tasks.size(); start += wave) {
                List<Callable<List<RawJob>>> chunk = tasks.subList(start, Math.min(start + wave, tasks.size()));
                List<Future<List<RawJob>>> futures;
                try {
                    futures = pool.invokeAll(chunk, 3, TimeUnit.MINUTES);
                } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
                for (Future<List<RawJob>> f : futures) {
                    List<RawJob> batch;
                    try { batch = f.get(); } catch (Exception e) { continue; }
                    String source = batch.isEmpty() ? null : batch.get(0).getSource();
                    int size = batch.size();
                    fetched += size;
                    for (RawJob r : batch) {
                        int code = upsert(r, profile);
                        if (code == 1) inserted++; else if (code == 2) updated++;
                    }
                    batch.clear(); // free this source before moving on
                    progress.source(source, size);
                    progress.counts(fetched, inserted, updated);
                }
            }
        } catch (Exception e) {
            log.warn("Ingest error: {}", e.getMessage());
            progress.note("Warning during fetch: " + e.getMessage());
        } finally {
            pool.shutdownNow();
        }

        // Clean the board: remove stale, non-tech and duplicate listings (keeps it lean
        // without needing a separate maintenance call).
        try {
            progress.note("Cleaning up stale & duplicate listings…");
            int purged = cleanup.purgeOldJobs();
            if (purged > 0) {
                log.info("Ingest cleanup: purged {} stale/non-tech/duplicate jobs", purged);
                progress.note("Removed " + purged + " stale / duplicate listing" + (purged == 1 ? "" : "s") + ".");
            }
        } catch (Exception e) {
            log.warn("Cleanup pass failed: {}", e.getMessage());
        }

        log.info("Ingest complete: fetched={} inserted={} updated={}", fetched, inserted, updated);
        progress.finish(fetched, inserted, updated, (int) jobRepo.count());
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
            // Jooble aggregates Naukri/Indeed/Shine/etc. Run every fresher/India query
            // so those postings land in the board (URLs deep-link to the originals).
            String kw = props.getJooble().getKeywords();
            if (kw == null || kw.isBlank()) return List.of();
            return java.util.Arrays.stream(kw.split(","))
                    .map(String::trim).filter(s -> !s.isEmpty())
                    .map(q -> FetchParams.builder().query(q).where("India").build())
                    .collect(Collectors.toList());
        }
        if ("google".equals(c.source())) {
            List<String> qs = props.getGoogleCse().getQueries();
            if (qs == null || qs.isEmpty()) return List.of();
            return qs.stream()
                    .map(q -> FetchParams.builder().query(q.trim()).build())
                    .collect(Collectors.toList());
        }
        if ("careerjet".equals(c.source())) {
            List<String> qs = props.getCareerjet().getQueries();
            if (qs == null || qs.isEmpty()) return List.of();
            return qs.stream()
                    .map(q -> FetchParams.builder().query(q.trim())
                            .where(props.getCareerjet().getWhere()).build())
                    .collect(Collectors.toList());
        }
        return List.of(FetchParams.builder().build());
    }

    /** Recompute match_score + region for ALL stored jobs with the current profile. */
    public int rescoreAll() {
        Profile profile = profileRepo.findFirstByOrderByUpdatedAtAsc().orElse(null);
        if (profile == null) return 0;
        int page = 0, size = 500, total = 0;
        org.springframework.data.domain.Page<Job> batch;
        do {
            batch = jobRepo.findAll(org.springframework.data.domain.PageRequest.of(page, size));
            for (Job j : batch.getContent()) {
                j.setMatchScore(scorer.score(j, profile));
                j.setRegion(normalize.region(j.getLocation(), j.isRemote()));
            }
            jobRepo.saveAll(batch.getContent());
            total += batch.getNumberOfElements();
            page++;
        } while (batch.hasNext());
        log.info("Rescored {} jobs", total);
        return total;
    }

    /** @return 0 = skipped, 1 = inserted, 2 = updated */
    @Transactional
    protected int upsert(RawJob r, Profile profile) {
        if (r.getTitle() == null || r.getUrl() == null) return 0;
        if (!normalize.isTechRole(r.getTitle())) return 0; // tech-only board
        // Freshness: skip dated jobs older than the retention window (keep undated ATS jobs).
        if (r.getPostedAt() != null
                && r.getPostedAt().isBefore(java.time.Instant.now().minus(java.time.Duration.ofDays(maxAgeDays)))) {
            return 0;
        }
        r.setRaw(null); // don't store the heavy raw payload (memory + DB)
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
