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
        return search(role, location, minScore, applyType, null, since, null, page, size);
    }

    public Page<Job> search(String role, String location, Integer minScore, String applyType,
                            String region, Instant since, Integer postedWithinDays, int page, int size) {
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
            return cb.and(ps.toArray(new Predicate[0]));
        };
        Sort sort = Sort.by(Sort.Order.desc("matchScore").nullsLast(), Sort.Order.desc("postedAt"));
        return repo.findAll(spec, PageRequest.of(Math.max(0, page), size, sort));
    }
}
