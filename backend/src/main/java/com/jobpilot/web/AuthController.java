package com.jobpilot.web;

import com.jobpilot.security.UserContext;
import com.jobpilot.service.AuthService;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService auth;

    public AuthController(AuthService auth) {
        this.auth = auth;
    }

    @PostMapping("/register")
    public Map<String, Object> register(@RequestBody Map<String, String> body) {
        return auth.register(body.get("email"), body.get("password"), body.get("fullName"));
    }

    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody Map<String, String> body) {
        return auth.login(body.get("email"), body.get("password"));
    }

    /** Current user (requires a valid JWT — not under /auth public exception). */
    @GetMapping("/me")
    public Map<String, Object> me() {
        return auth.me(UserContext.require());
    }
}
