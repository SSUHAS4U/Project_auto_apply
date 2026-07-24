package com.jobpilot.service;

import com.jobpilot.domain.Job;
import com.jobpilot.repository.JobRepository;
import jakarta.persistence.criteria.Predicate;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Service
public class JobService {

    private final JobRepository repo;

    public JobService(JobRepository repo) {
        this.repo = repo;
    }

    public Job get(UUID id) {
        return repo.findById(id).orElseThrow(() -> new NotFoundException("job not found: " + id));
    }

    /** Free-text search over title/company/description+location for the assistant. */
    public List<Job> keywordSearch(String text, int limit) {
        String[] words = text == null ? new String[0]
                : text.toLowerCase().split("[^a-z0-9+#.]+");
        Specification<Job> spec = (root, query, cb) -> {
            List<Predicate> ors = new ArrayList<>();
            for (String w : words) {
                if (w.length() < 3) continue;
                String like = "%" + w + "%";
                ors.add(cb.like(cb.lower(root.get("title")), like));
                ors.add(cb.like(cb.lower(root.get("description")), like));
                ors.add(cb.like(cb.lower(root.get("company")), like));
                ors.add(cb.like(cb.lower(root.get("location")), like));
            }
            return ors.isEmpty() ? cb.conjunction() : cb.or(ors.toArray(new Predicate[0]));
        };
        Sort sort = Sort.by(Sort.Order.desc("matchScore").nullsLast(), Sort.Order.desc("postedAt"));
        return repo.findAll(spec, PageRequest.of(0, Math.max(1, limit), sort)).getContent();
    }

    public Page<Job> search(String role, String location, Integer minScore,
                            String applyType, Instant since, int page, int size) {
        return search(role, location, minScore, applyType, null, since, null, null, null, page, size);
    }

    /** Back-compat overload for callers that don't care about level/sort. */
    public Page<Job> search(String role, String location, Integer minScore, String applyType,
                            String region, Instant since, Integer postedWithinDays, int page, int size) {
        return search(role, location, minScore, applyType, region, since, postedWithinDays, null, null, page, size);
    }

    /**
     * Seniority markers in a job TITLE. Title-based is the only signal that always exists —
     * Workday's listing carries no description at all, and it alone can push thousands of
     * enterprise roles onto the board that a fresher can never apply to.
     */
    private static final List<String> SENIOR_WORDS = List.of(
            "senior", "sr.", "sr ", "staff", "principal", "lead", "manager", "director",
            "architect", "head of", "vp", "vice president", "chief", "distinguished",
            "fellow", " ii", " iii", " iv");
    /** The subset that still rules a role out for someone mid-level. */
    private static final List<String> ABOVE_MID_WORDS = List.of(
            "principal", "staff", "director", "head of", "vp", "vice president", "chief",
            "distinguished", "fellow", "architect");
    /** Year demands that disqualify an entry-level candidate when a description exists. */
    private static final List<String> HEAVY_YEARS = List.of(
            "5+ year", "6+ year", "7+ year", "8+ year", "9+ year", "10+ year",
            "5+ yrs", "6+ yrs", "7+ yrs", "8+ yrs", "10+ yrs");

    public Page<Job> search(String role, String location, Integer minScore, String applyType,
                            String region, Instant since, Integer postedWithinDays,
                            String level, String sort, int page, int size) {
        final Instant freshCutoff = (postedWithinDays != null && postedWithinDays > 0)
                ? Instant.now().minus(java.time.Duration.ofDays(postedWithinDays)) : null;
        Specification<Job> spec = (root, query, cb) -> {
            List<Predicate> ps = new ArrayList<>();
            if (role != null && !role.isBlank()) {
                // Comma-separated = "any of these titles". Lets the board default to the set of
                // roles you actually apply for (full stack / frontend / backend / SDE / devops…)
                // instead of forcing one keyword at a time.
                List<Predicate> anyRole = new ArrayList<>();
                for (String term : role.split(",")) {
                    String t = term.trim().toLowerCase();
                    if (!t.isEmpty()) anyRole.add(cb.like(cb.lower(root.get("title")), "%" + t + "%"));
                }
                if (!anyRole.isEmpty()) ps.add(cb.or(anyRole.toArray(new Predicate[0])));
            }
            if (location != null && !location.isBlank()) {
                ps.add(cb.like(cb.lower(root.get("location")), "%" + location.toLowerCase() + "%"));
            }
            if (minScore != null) {
                ps.add(cb.greaterThanOrEqualTo(root.get("matchScore"), minScore));
            }
            if (applyType != null && !applyType.isBlank()) {
                ps.add(cb.equal(root.get("applyType"), applyType));
            }
            if (region != null && !region.isBlank()) {
                ps.add(cb.equal(root.get("region"), region)); // india / remote / outside are now distinct
            }
            if (since != null) {
                ps.add(cb.greaterThanOrEqualTo(root.get("fetchedAt"), since));
            }
            if (freshCutoff != null) {
                // Judge age by the posted date, falling back to when we first fetched it. The
                // previous rule let every undated job through ("postedAt IS NULL OR …"), which
                // is why a "last 24 hours" filter still returned month-old listings.
                ps.add(cb.greaterThanOrEqualTo(
                        cb.coalesce(root.get("postedAt"), root.get("fetchedAt")), freshCutoff));
            }
            // Experience level. Titles are checked always; the year demands only when the
            // source actually gave us a description to read.
            if ("entry".equalsIgnoreCase(level) || "mid".equalsIgnoreCase(level)) {
                List<String> banned = "entry".equalsIgnoreCase(level) ? SENIOR_WORDS : ABOVE_MID_WORDS;
                for (String w : banned) {
                    ps.add(cb.notLike(cb.lower(root.get("title")), "%" + w + "%"));
                }
                if ("entry".equalsIgnoreCase(level)) {
                    for (String y : HEAVY_YEARS) {
                        ps.add(cb.or(cb.isNull(root.get("description")),
                                cb.notLike(cb.lower(root.get("description")), "%" + y + "%")));
                    }
                }
            }
            return cb.and(ps.toArray(new Predicate[0]));
        };
        // "recent" puts the newest first outright; the default leads with best match and uses
        // recency to break ties.
        Sort order = "recent".equalsIgnoreCase(sort)
                ? Sort.by(Sort.Order.desc("postedAt").nullsLast(), Sort.Order.desc("matchScore").nullsLast())
                : Sort.by(Sort.Order.desc("matchScore").nullsLast(), Sort.Order.desc("postedAt").nullsLast());
        return repo.findAll(spec, PageRequest.of(Math.max(0, page), size, order));
    }
}
