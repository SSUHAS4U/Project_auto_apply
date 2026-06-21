package com.jobpilot.web;

import com.jobpilot.service.AdminService;
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

    public AdminController(AdminService admin) {
        this.admin = admin;
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
