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

    /** Current user (requires a valid JWT — not under /auth public exception). */
    @GetMapping("/me")
    public Map<String, Object> me() {
        return auth.me(UserContext.require());
    }
}
