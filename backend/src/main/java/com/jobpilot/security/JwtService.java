package com.jobpilot.security;

import com.jobpilot.config.JobPilotProperties;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;

/** Signs/verifies HS256 JWTs carrying the user id (subject) + email. */
@Component
public class JwtService {

    private final SecretKey key;
    private final long ttlSeconds;

    public JwtService(JobPilotProperties props,
                      @org.springframework.beans.factory.annotation.Value(
                              "${spring.datasource.url:}") String datasourceUrl) {
        // Policy lives in JwtSecretResolver, not here: this class signs and verifies, it does
        // not decide what is safe to sign with. The resolver refuses to return a key at all
        // when production would otherwise sign with something weak or publicly known.
        this.key = Keys.hmacShaKeyFor(
                JwtSecretResolver.resolveKey(props.getJwt().getSecret(), datasourceUrl));
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
