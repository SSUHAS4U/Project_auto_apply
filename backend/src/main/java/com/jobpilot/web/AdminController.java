package com.jobpilot.web;

import com.jobpilot.service.AdminService;
import com.jobpilot.service.SecretService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Admin-only endpoints. AuthFilter requires an ADMIN-role JWT for every /api/admin/**
 * route (the static machine token cannot reach here), so these are safe by construction.
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private final AdminService admin;
    private final SecretService secrets;

    public AdminController(AdminService admin, SecretService secrets) {
        this.admin = admin;
        this.secrets = secrets;
    }

    // --- API keys / secrets (values are write-only; never returned) -----------
    @GetMapping("/secrets")
    public List<Map<String, Object>> secrets() {
        return secrets.status();
    }

    @PutMapping("/secrets/{name}")
    public Map<String, Object> setSecret(@PathVariable String name, @RequestBody Map<String, String> body) {
        secrets.set(name, body.get("value"));
        return Map.of("saved", true);
    }

    @DeleteMapping("/secrets/{name}")
    public Map<String, Object> deleteSecret(@PathVariable String name) {
        secrets.delete(name);
        return Map.of("deleted", true);
    }

    @GetMapping("/users")
    public List<Map<String, Object>> users(@RequestParam(required = false) String q) {
        return admin.listUsers(q);
    }

    @GetMapping("/users/{id}")
    public Map<String, Object> user(@PathVariable UUID id) {
        return admin.userDetail(id);
    }

    @DeleteMapping("/users/{id}")
    public Map<String, Object> deleteUser(@PathVariable UUID id) {
        admin.deleteUser(id);
        return Map.of("deleted", true);
    }

    @PostMapping("/users/{id}/role")
    public Map<String, Object> setRole(@PathVariable UUID id, @RequestBody Map<String, String> body) {
        return admin.setRole(id, body.get("role"));
    }
}
