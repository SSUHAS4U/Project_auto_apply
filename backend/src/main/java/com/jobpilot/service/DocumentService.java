package com.jobpilot.service;

import com.jobpilot.domain.AppUser;
import com.jobpilot.domain.Document;
import com.jobpilot.repository.AppUserRepository;
import com.jobpilot.repository.DocumentRepository;
import com.jobpilot.security.DocumentCrypto;
import com.jobpilot.security.UserContext;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.util.*;

/**
 * Per-user document vault. Bytes are AES-GCM encrypted before storage; downloads
 * require re-entering the account password. Everything is scoped to the calling user.
 */
@Service
public class DocumentService {

    private final DocumentRepository repo;
    private final AppUserRepository users;
    private final DocumentCrypto crypto;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public DocumentService(DocumentRepository repo, AppUserRepository users, DocumentCrypto crypto) {
        this.repo = repo;
        this.users = users;
        this.crypto = crypto;
    }

    @Transactional
    public Map<String, Object> store(MultipartFile file, String name, String type) {
        if (file == null || file.isEmpty()) throw new IllegalArgumentException("file is empty");
        if (file.getSize() > 10L * 1024 * 1024) throw new IllegalArgumentException("file exceeds 10 MB");
        try {
            Document d = new Document();
            d.setUserId(UserContext.require());
            d.setName(name == null || name.isBlank() ? file.getOriginalFilename() : name.trim());
            d.setDocType(type == null || type.isBlank() ? "other" : type.trim().toLowerCase());
            d.setFilename(file.getOriginalFilename() == null ? "file" : file.getOriginalFilename());
            d.setContentType(file.getContentType() == null ? "application/octet-stream" : file.getContentType());
            d.setSizeBytes(file.getSize());
            d.setData(crypto.encrypt(file.getBytes())); // encrypt at rest
            return meta(repo.save(d));
        } catch (java.io.IOException e) {
            throw new IllegalStateException("failed to read file: " + e.getMessage(), e);
        }
    }

    public List<Map<String, Object>> list() {
        return repo.findByUserIdOrderByCreatedAtDesc(UserContext.require()).stream().map(this::meta).toList();
    }

    /** Verify the account password, then decrypt and return the file. */
    public Download download(UUID id, String password) {
        UUID userId = UserContext.require();
        AppUser u = users.findById(userId).orElseThrow(() -> new NotFoundException("user not found"));
        if (password == null || !encoder.matches(password, u.getPasswordHash())) {
            throw new SecurityException("incorrect password");
        }
        Document d = repo.findById(id)
                .filter(doc -> userId.equals(doc.getUserId()))
                .orElseThrow(() -> new NotFoundException("document not found"));
        byte[] plain = crypto.decrypt(d.getData());
        return new Download(d.getFilename(), d.getContentType(), plain);
    }

    @Transactional
    public void delete(UUID id) {
        UUID userId = UserContext.require();
        repo.findById(id).filter(d -> userId.equals(d.getUserId())).ifPresent(repo::delete);
    }

    private Map<String, Object> meta(Document d) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", d.getId().toString());
        m.put("name", d.getName());
        m.put("type", d.getDocType());
        m.put("filename", d.getFilename());
        m.put("contentType", d.getContentType());
        m.put("sizeBytes", d.getSizeBytes());
        m.put("createdAt", d.getCreatedAt() == null ? null : d.getCreatedAt().toString());
        return m;
    }

    public record Download(String filename, String contentType, byte[] bytes) {}
}
