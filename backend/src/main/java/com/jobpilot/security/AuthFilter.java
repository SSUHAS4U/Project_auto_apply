package com.jobpilot.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.UUID;

/**
 * Guards {@code /api/**}:
 *  - {@code /api/auth/**} → public (register/login).
 *  - ops/cron paths → require the static admin token ({@code X-Api-Token}).
 *  - everything else → require a valid JWT ({@code Authorization: Bearer}); sets UserContext.
 */
public class AuthFilter extends OncePerRequestFilter {

    private static final List<String> ADMIN_PREFIXES = List.of(
            "/api/ingest", "/api/daily/run", "/api/digest", "/api/maintenance", "/api/ops");

    private final byte[] adminToken;
    private final JwtService jwt;

    public AuthFilter(String adminToken, JwtService jwt) {
        this.adminToken = adminToken == null ? new byte[0] : adminToken.getBytes(StandardCharsets.UTF_8);
        this.jwt = jwt;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        if (HttpMethod.OPTIONS.matches(req.getMethod())) { chain.doFilter(req, res); return; }

        String path = req.getServletPath();
        if (path.equals("/api/auth/login") || path.equals("/api/auth/register")) {
            chain.doFilter(req, res); return; // public
        }

        if (isAdmin(path)) {
            String provided = req.getHeader("X-Api-Token");
            if (provided == null || !constantTimeEquals(provided.getBytes(StandardCharsets.UTF_8), adminToken)) {
                deny(res, "missing or invalid admin token");
                return;
            }
            chain.doFilter(req, res);
            return;
        }

        // User route → JWT
        String auth = req.getHeader("Authorization");
        String token = (auth != null && auth.startsWith("Bearer ")) ? auth.substring(7) : req.getHeader("X-Auth-Token");
        UUID userId = token == null ? null : jwt.parseUserId(token);
        if (userId == null) {
            deny(res, "login required");
            return;
        }
        try {
            UserContext.set(userId);
            chain.doFilter(req, res);
        } finally {
            UserContext.clear();
        }
    }

    private boolean isAdmin(String path) {
        for (String p : ADMIN_PREFIXES) if (path.startsWith(p)) return true;
        return false;
    }

    private void deny(HttpServletResponse res, String msg) throws IOException {
        res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        res.setContentType(MediaType.APPLICATION_JSON_VALUE);
        res.getWriter().write("{\"error\":\"unauthorized\",\"message\":\"" + msg + "\"}");
    }

    private static boolean constantTimeEquals(byte[] a, byte[] b) {
        return MessageDigest.isEqual(a, b);
    }
}
