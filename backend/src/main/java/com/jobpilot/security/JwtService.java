package com.jobpilot.security;

import com.jobpilot.config.JobPilotProperties;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;

/** Signs/verifies HS256 JWTs carrying the user id (subject) + email. */
@Component
public class JwtService {

    private final SecretKey key;
    private final long ttlSeconds;

    public JwtService(JobPilotProperties props) {
        String secret = props.getJwt().getSecret();
        // Pad short secrets so HS256 always has >=256 bits of key material.
        byte[] bytes = (secret + "jobpilot-jwt-padding-0000000000000000000000000000")
                .getBytes(StandardCharsets.UTF_8);
        this.key = Keys.hmacShaKeyFor(java.util.Arrays.copyOf(bytes, 32));
        this.ttlSeconds = props.getJwt().getTtlSeconds();
    }

    public String issue(UUID userId, String email) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(userId.toString())
                .claim("email", email)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(Duration.ofSeconds(ttlSeconds))))
                .signWith(key)
                .compact();
    }

    /** Returns the user id from a valid token, or null if invalid/expired. */
    public UUID parseUserId(String token) {
        try {
            Claims c = Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
            return UUID.fromString(c.getSubject());
        } catch (Exception e) {
            return null;
        }
    }
}
