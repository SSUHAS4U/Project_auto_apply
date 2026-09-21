package com.jobpilot.web;

import com.jobpilot.security.LoginThrottle;
import com.jobpilot.security.UserContext;
import com.jobpilot.service.ops.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService auth;
    private final LoginThrottle throttle;

    public AuthController(AuthService auth, LoginThrottle throttle) {
        this.auth = auth;
        this.throttle = throttle;
    }

    /**
     * The caller's address, preferring X-Forwarded-For because this runs behind Caddy and
     * the socket address would otherwise be the proxy for every request — one shared bucket,
     * so one attacker would lock out everybody.
     *
     * Only the FIRST hop is used and only the part before any comma: the rest of that header
     * is attacker-supplied and trivially forged. Treating a forged later hop as the identity
     * would let an attacker rotate it per request and never trip the limit at all.
     */
    private static String clientAddress(HttpServletRequest req) {
        String fwd = req.getHeader("X-Forwarded-For");
        if (fwd != null && !fwd.isBlank()) {
            String first = fwd.split(",")[0].trim();
            if (!first.isEmpty()) return first;
        }
        return req.getRemoteAddr();
    }

    @PostMapping("/register")
    public Map<String, Object> register(@RequestBody Map<String, String> body,
                                        HttpServletRequest req) {
        // Throttled on the ADDRESS key too, so one host cannot mass-create accounts. This is a
        // public endpoint on a single-operator deployment; unlimited registration is free
        // storage and free AI quota for anyone who finds the URL.
        String addr = clientAddress(req);
        throttle.checkAllowed(body.get("email"), addr);
        try {
            return auth.register(body.get("email"), body.get("password"), body.get("fullName"));
        } catch (RuntimeException e) {
            throttle.recordFailure(body.get("email"), addr);
            throw e;
        }
    }

    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody Map<String, String> body,
                                     HttpServletRequest req) {
        String email = body.get("email");
        String addr = clientAddress(req);
        throttle.checkAllowed(email, addr);
        try {
            Map<String, Object> out = auth.login(email, body.get("password"));
            throttle.recordSuccess(email, addr);
            return out;
        } catch (RuntimeException e) {
            throttle.recordFailure(email, addr);
            throw e;
        }
    }

    /**
     * Sign in with Google. The body carries the ID token ("credential") that the Google button
     * returned; the server verifies it — the browser's word is never taken for who signed in.
     * Throttled per address like password login: a flood of forged tokens costs the caller a
     * lockout, not us a JWKS fetch each.
     */
    @PostMapping("/google")
    public Map<String, Object> google(@RequestBody Map<String, String> body, HttpServletRequest req) {
        String addr = clientAddress(req);
        throttle.checkAllowed("google", addr);
        try {
            Map<String, Object> out = auth.google(body.get("credential"));
            throttle.recordSuccess("google", addr);
            return out;
        } catch (IllegalArgumentException | SecurityException e) {
            throttle.recordFailure("google", addr);
            throw e;
        }
    }

    /** Public: whether Google sign-in is available and whether sign-up is open. */
    @GetMapping("/config")
    public Map<String, Object> config() {
        return auth.publicConfig();
    }

    /** Current user (requires a valid JWT — not under /auth public exception). */
    @GetMapping("/me")
    public Map<String, Object> me() {
        return auth.me(UserContext.require());
    }
}
