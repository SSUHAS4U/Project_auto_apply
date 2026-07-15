package com.jobpilot.security;

import com.jobpilot.repository.AppUserRepository;
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
 * Guards {@code /api/**} with a defence-in-depth model:
 *  - {@code /api/auth/login|register} → public.
 *  - {@code /api/admin/**} → JWT whose user has role=ADMIN (checked in the DB,
 *    never from the token). A static token can NEVER reach these routes, so a
 *    leaked machine token cannot manage users or escalate privileges.
 *  - ops/cron routes (ingest/daily/digest/maintenance/ops) → the static admin
 *    token (for GitHub Actions cron) OR an ADMIN JWT (for the dashboard button).
 *  - everything else → any valid JWT; sets UserContext for per-user data isolation.
 *
 * Admin status is authoritative in the database: tokens carry only an identity
 * (the signed user id), so they cannot be forged or replayed into admin access.
 */
public class AuthFilter extends OncePerRequestFilter {

    // Cron endpoints: the GitHub Actions machine token OR an ADMIN JWT may call these.
    private static final List<String> CRON_PREFIXES = List.of(
            "/api/ingest", "/api/daily/run", "/api/digest", "/api/sources");
    // Sensitive admin surfaces: ADMIN JWT ONLY. The static token can never reach these,
    // so a leaked machine token cannot manage users or wipe/maintain data.
    private static final List<String> ADMIN_ONLY_PREFIXES = List.of(
            "/api/admin", "/api/maintenance", "/api/ops");

    private final byte[] adminToken;
    private final JwtService jwt;
    private final AppUserRepository users;
    private final WorkerTokenService workerTokens;

    public AuthFilter(String adminToken, JwtService jwt, AppUserRepository users,
                      WorkerTokenService workerTokens) {
        this.adminToken = adminToken == null ? new byte[0] : adminToken.getBytes(StandardCharsets.UTF_8);
        this.jwt = jwt;
        this.users = users;
        this.workerTokens = workerTokens;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        if (HttpMethod.OPTIONS.matches(req.getMethod())) { chain.doFilter(req, res); return; }

        String path = req.getServletPath();
        if (path.equals("/api/auth/login") || path.equals("/api/auth/register")) {
            chain.doFilter(req, res); return; // public
        }

        // --- local worker : dedicated worker token (bound to its owning user) ---
        // The Playwright worker on the owner's PC hits /api/worker/** with X-Worker-Token.
        // It can NEVER reach any other route, so a leaked worker token can't touch user data.
        if (path.startsWith("/api/worker/")) {
            UUID workerUser = workerTokens.verify(req.getHeader("X-Worker-Token"));
            if (workerUser == null) { deny(res, 401, "invalid worker token"); return; }
            withUser(workerUser, req, res, chain);
            return;
        }

        UUID userId = jwtUserId(req);

        // --- admin surfaces (users / maintenance / ops) : ADMIN JWT only, no static token ---
        if (matches(path, ADMIN_ONLY_PREFIXES)) {
            if (userId == null) { deny(res, 401, "login required"); return; }
            if (!isAdmin(userId)) { deny(res, 403, "admin access required"); return; }
            withUser(userId, req, res, chain);
            return;
        }

        // --- scout run : machine token (cron) OR any signed-in user ("Scout now" button).
        //     Scheduled runs happen in-process (DailyScheduler); this only adds manual runs. ---
        if (path.startsWith("/api/scout/run")) {
            if (staticTokenValid(req)) { chain.doFilter(req, res); return; }
            if (userId != null) { withUser(userId, req, res, chain); return; }
            deny(res, 401, "login required");
            return;
        }

        // --- cron : the machine token (GitHub Actions) OR an ADMIN JWT (dashboard button) ---
        if (matches(path, CRON_PREFIXES)) {
            if (staticTokenValid(req)) { chain.doFilter(req, res); return; }
            if (userId != null && isAdmin(userId)) { withUser(userId, req, res, chain); return; }
            deny(res, 403, "admin token or admin account required");
            return;
        }

        // --- user route : any valid JWT ---
        if (userId == null) { deny(res, 401, "login required"); return; }
        withUser(userId, req, res, chain);
    }

    private UUID jwtUserId(HttpServletRequest req) {
        String auth = req.getHeader("Authorization");
        String token = (auth != null && auth.startsWith("Bearer ")) ? auth.substring(7) : req.getHeader("X-Auth-Token");
        return token == null ? null : jwt.parseUserId(token);
    }

    private boolean isAdmin(UUID userId) {
        return users.findById(userId).map(u -> u.isAdmin()).orElse(false);
    }

    private boolean staticTokenValid(HttpServletRequest req) {
        String provided = req.getHeader("X-Api-Token");
        return provided != null && adminToken.length > 0
                && constantTimeEquals(provided.getBytes(StandardCharsets.UTF_8), adminToken);
    }

    private void withUser(UUID userId, HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        try {
            UserContext.set(userId);
            chain.doFilter(req, res);
        } finally {
            UserContext.clear();
        }
    }

    private boolean matches(String path, List<String> prefixes) {
        for (String p : prefixes) if (path.startsWith(p)) return true;
        return false;
    }

    private void deny(HttpServletResponse res, int status, String msg) throws IOException {
        res.setStatus(status);
        res.setContentType(MediaType.APPLICATION_JSON_VALUE);
        res.getWriter().write("{\"error\":\"unauthorized\",\"message\":\"" + msg + "\"}");
    }

    private static boolean constantTimeEquals(byte[] a, byte[] b) {
        return MessageDigest.isEqual(a, b);
    }
}
