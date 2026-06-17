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

    public Page<Job> search(String role, String location, Integer minScore,
                            String applyType, Instant since, int page, int size) {
        Specification<Job> spec = (root, query, cb) -> {
            List<Predicate> ps = new ArrayList<>();
            if (role != null && !role.isBlank()) {
                ps.add(cb.like(cb.lower(root.get("title")), "%" + role.toLowerCase() + "%"));
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
            if (since != null) {
                ps.add(cb.greaterThanOrEqualTo(root.get("fetchedAt"), since));
            }
            return cb.and(ps.toArray(new Predicate[0]));
        };
        Sort sort = Sort.by(Sort.Order.desc("matchScore").nullsLast(), Sort.Order.desc("postedAt"));
        return repo.findAll(spec, PageRequest.of(Math.max(0, page), size, sort));
    }
}
