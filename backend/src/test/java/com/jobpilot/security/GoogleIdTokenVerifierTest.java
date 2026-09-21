package com.jobpilot.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Jwks;
import io.jsonwebtoken.security.RsaPublicJwk;
import org.junit.jupiter.api.Test;

import java.security.KeyPair;
import java.security.interfaces.RSAPublicKey;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Every claim Google's guide says to check is checked here by a token that gets exactly that one
 * claim wrong — signed with a real RSA key and served from a real JWK set, so the test exercises
 * the same parse → locate key → verify path production does, minus the network.
 */
class GoogleIdTokenVerifierTest {

    private static final String CLIENT = "123-abc.apps.googleusercontent.com";
    private static final Instant NOW = Instant.parse("2026-09-21T10:00:00Z");
    private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);

    private final KeyPair google = Jwts.SIG.RS256.keyPair().build();
    private final KeyPair attacker = Jwts.SIG.RS256.keyPair().build();

    private static String jwks(String kid, KeyPair kp) throws Exception {
        RsaPublicJwk jwk = Jwks.builder().key((RSAPublicKey) kp.getPublic()).id(kid).build();
        return new ObjectMapper().writeValueAsString(Map.of("keys", List.of(Map.copyOf(jwk))));
    }

    private String token(String kid, KeyPair signer, String aud, String iss, Instant exp, Object emailVerified) {
        return Jwts.builder()
                .header().keyId(kid).and()
                .issuer(iss).audience().add(aud).and()
                .subject("10987654321")
                .claim("email", "Owner@Example.com")
                .claim("email_verified", emailVerified)
                .claim("name", "Suhas S")
                .issuedAt(Date.from(NOW.minusSeconds(60)))
                .expiration(Date.from(exp))
                .signWith(signer.getPrivate())
                .compact();
    }

    private String good() {
        return token("k1", google, CLIENT, "https://accounts.google.com", NOW.plusSeconds(3600), true);
    }

    private GoogleIdTokenVerifier verifier(AtomicInteger fetches) throws Exception {
        String set = jwks("k1", google);
        return new GoogleIdTokenVerifier(CLIENT, () -> { fetches.incrementAndGet(); return set; }, CLOCK);
    }

    @Test
    void aValidTokenYieldsTheVerifiedLowercasedIdentity() throws Exception {
        GoogleIdTokenVerifier.GoogleIdentity id = verifier(new AtomicInteger()).verify(good());
        assertEquals("owner@example.com", id.email());
        assertEquals("10987654321", id.sub());
        assertEquals("Suhas S", id.name());
    }

    @Test
    void bothIssuerSpellingsGoogleUsesAreAccepted() throws Exception {
        String t = token("k1", google, CLIENT, "accounts.google.com", NOW.plusSeconds(3600), true);
        assertEquals("owner@example.com", verifier(new AtomicInteger()).verify(t).email());
    }

    @Test
    void aTokenMintedForAnotherAppIsRefused() throws Exception {
        String t = token("k1", google, "someone-else.apps.googleusercontent.com",
                "https://accounts.google.com", NOW.plusSeconds(3600), true);
        assertThrows(IllegalArgumentException.class, () -> verifier(new AtomicInteger()).verify(t));
    }

    @Test
    void aTokenFromAnotherIssuerIsRefused() throws Exception {
        String t = token("k1", google, CLIENT, "https://evil.example", NOW.plusSeconds(3600), true);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> verifier(new AtomicInteger()).verify(t));
        assertTrue(e.getMessage().contains("Google"), e.getMessage());
    }

    @Test
    void anExpiredTokenIsRefused() throws Exception {
        String t = token("k1", google, CLIENT, "https://accounts.google.com", NOW.minusSeconds(120), true);
        assertThrows(IllegalArgumentException.class, () -> verifier(new AtomicInteger()).verify(t));
    }

    @Test
    void anUnverifiedEmailNeverMatchesAnAccount() throws Exception {
        String t = token("k1", google, CLIENT, "https://accounts.google.com", NOW.plusSeconds(3600), false);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> verifier(new AtomicInteger()).verify(t));
        assertTrue(e.getMessage().contains("isn't verified"), e.getMessage());
    }

    @Test
    void aTokenSignedByAnotherKeyUnderGooglesKeyIdIsRefused() throws Exception {
        String forged = token("k1", attacker, CLIENT, "https://accounts.google.com", NOW.plusSeconds(3600), true);
        assertThrows(IllegalArgumentException.class, () -> verifier(new AtomicInteger()).verify(forged));
    }

    @Test
    void aRotatedKeyIsPickedUpWithExactlyOneRefetch() throws Exception {
        AtomicInteger fetches = new AtomicInteger();
        AtomicReference<String> served = new AtomicReference<>(jwks("old", attacker));
        // Clock far enough past the first fetch that the one-a-minute refetch guard allows it.
        AtomicReference<Instant> now = new AtomicReference<>(NOW);
        Clock moving = new Clock() {
            public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
            public Clock withZone(java.time.ZoneId z) { return this; }
            public Instant instant() { return now.get(); }
        };
        GoogleIdTokenVerifier v = new GoogleIdTokenVerifier(CLIENT,
                () -> { fetches.incrementAndGet(); return served.get(); }, moving);

        // Prime the cache with the old set: a token under an unknown kid fails, after one refetch.
        assertThrows(IllegalArgumentException.class, () -> v.verify(good()));
        int afterFirst = fetches.get();

        served.set(jwks("k1", google));   // Google rotates
        now.set(NOW.plusSeconds(120));      // past the refetch guard
        String t = Jwts.builder().header().keyId("k1").and().issuer("https://accounts.google.com")
                .audience().add(CLIENT).and().subject("1").claim("email", "a@b.co").claim("email_verified", true)
                .expiration(Date.from(NOW.plusSeconds(3600))).signWith(google.getPrivate()).compact();
        assertEquals("a@b.co", v.verify(t).email());
        assertEquals(afterFirst + 1, fetches.get(), "one refetch for the rotated key, not one per request");

        // Cached now: the next verify does not fetch again.
        v.verify(t);
        assertEquals(afterFirst + 1, fetches.get());
    }

    @Test
    void unconfiguredFailsClosedAndNamesTheVariableToSet() {
        GoogleIdTokenVerifier v = new GoogleIdTokenVerifier("", () -> "{}", CLOCK);
        assertFalse(v.isConfigured());
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> v.verify(good()));
        assertTrue(e.getMessage().contains("JOBPILOT_GOOGLE_CLIENT_ID"), e.getMessage());
    }

    @Test
    void aMissingCredentialIsABadRequestNotACrash() throws Exception {
        GoogleIdTokenVerifier v = verifier(new AtomicInteger());
        assertThrows(IllegalArgumentException.class, () -> v.verify(null));
        assertThrows(IllegalArgumentException.class, () -> v.verify("  "));
        assertThrows(IllegalArgumentException.class, () -> v.verify("not.a.jwt"));
    }
}
