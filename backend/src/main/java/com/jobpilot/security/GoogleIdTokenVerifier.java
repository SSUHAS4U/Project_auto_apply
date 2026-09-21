package com.jobpilot.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwsHeader;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.LocatorAdapter;
import io.jsonwebtoken.security.Jwk;
import io.jsonwebtoken.security.JwkSet;
import io.jsonwebtoken.security.Jwks;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.security.Key;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Verifies a "Sign in with Google" ID token (the {@code credential} the Google Identity Services
 * button hands the browser) and returns the verified identity.
 *
 * <p>What a valid token must prove, per Google's "Verify the ID token" guide:
 * <ul>
 *   <li>signed by one of Google's published keys ({@code /oauth2/v3/certs}, located by {@code kid})</li>
 *   <li>{@code aud} is OUR client id — a token minted for any other app is rejected</li>
 *   <li>{@code iss} is {@code accounts.google.com} or {@code https://accounts.google.com}</li>
 *   <li>not expired (jjwt enforces {@code exp})</li>
 *   <li>{@code email_verified} is true — an unverified address must never match an account</li>
 * </ul>
 *
 * <p>Fails closed: no client id configured means every token is refused, with a message that
 * says which variable to set. The key set is cached for an hour and refetched early only when a
 * token names a key we don't have (Google rotates keys), at most once a minute, so a flood of
 * forged {@code kid}s can't turn this into a request amplifier against Google.
 */
@Component
public class GoogleIdTokenVerifier {

    private static final Logger log = LoggerFactory.getLogger(GoogleIdTokenVerifier.class);
    static final String CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
    private static final Set<String> ISSUERS = Set.of("accounts.google.com", "https://accounts.google.com");
    private static final Duration CACHE_TTL = Duration.ofHours(1);
    private static final Duration MIN_REFETCH = Duration.ofMinutes(1);

    /** A verified Google identity. {@code sub} is Google's stable account id. */
    public record GoogleIdentity(String sub, String email, String name) {}

    private final String clientId;
    private final Supplier<String> jwksSource;
    private final Clock clock;

    private volatile JwkSet keys;
    private volatile Instant fetchedAt = Instant.EPOCH;

    @Autowired
    public GoogleIdTokenVerifier(@Value("${jobpilot.security.google-client-id:}") String clientId,
                                 RestClient http) {
        this(clientId, () -> http.get().uri(CERTS_URL).retrieve().body(String.class), Clock.systemUTC());
    }

    /** Test seam: a key source and clock that don't touch the network. */
    GoogleIdTokenVerifier(String clientId, Supplier<String> jwksSource, Clock clock) {
        this.clientId = clientId == null ? "" : clientId.trim();
        this.jwksSource = jwksSource;
        this.clock = clock;
    }

    public boolean isConfigured() {
        return !clientId.isEmpty();
    }

    /** The public client id the browser needs to render the button; empty when unconfigured. */
    public String clientId() {
        return clientId;
    }

    /**
     * @throws IllegalStateException    Google sign-in isn't configured on this server
     * @throws IllegalArgumentException the token is missing, forged, expired, for another app,
     *                                  or carries an unverified email
     */
    public GoogleIdentity verify(String credential) {
        if (!isConfigured()) {
            throw new IllegalStateException("Google sign-in isn't set up on this server — "
                    + "set JOBPILOT_GOOGLE_CLIENT_ID to the OAuth client id from Google Cloud Console");
        }
        if (credential == null || credential.isBlank()) {
            throw new IllegalArgumentException("Google didn't send a sign-in token — try the Google button again");
        }
        Claims c;
        try {
            c = Jwts.parser()
                    .keyLocator(new LocatorAdapter<Key>() {
                        @Override
                        protected Key locate(JwsHeader header) {
                            return keyFor(header.getKeyId());
                        }
                    })
                    .requireAudience(clientId)
                    .clock(() -> java.util.Date.from(clock.instant()))
                    .build()
                    .parseSignedClaims(credential)
                    .getPayload();
        } catch (JwtException | IllegalArgumentException e) {
            log.info("Rejected Google ID token: {}", e.getMessage());
            throw new IllegalArgumentException("Google sign-in couldn't be verified — try again. "
                    + "If it keeps failing, log in with your email and password.");
        }
        if (!ISSUERS.contains(c.getIssuer())) {
            throw new IllegalArgumentException("That sign-in token wasn't issued by Google");
        }
        Object verified = c.get("email_verified");
        boolean ok = Boolean.TRUE.equals(verified) || "true".equals(verified);
        String email = c.get("email", String.class);
        if (email == null || email.isBlank() || !ok) {
            throw new IllegalArgumentException("Your Google account's email isn't verified, so it can't be used "
                    + "to sign in. Verify it with Google, or log in with your email and password.");
        }
        return new GoogleIdentity(c.getSubject(), email.trim().toLowerCase(java.util.Locale.ROOT),
                c.get("name", String.class));
    }

    private Key keyFor(String kid) {
        if (kid == null || kid.isBlank()) throw new IllegalArgumentException("token has no key id");
        JwkSet set = currentKeys(false);
        Jwk<?> jwk = set.getKeys().stream().filter(k -> kid.equals(k.getId())).findFirst().orElse(null);
        if (jwk == null) {
            // Google rotated its keys since our last fetch — refresh once, then give up.
            set = currentKeys(true);
            jwk = set.getKeys().stream().filter(k -> kid.equals(k.getId())).findFirst().orElse(null);
        }
        if (jwk == null) throw new IllegalArgumentException("token signed with an unknown key");
        return jwk.toKey();
    }

    private synchronized JwkSet currentKeys(boolean unknownKid) {
        Instant now = clock.instant();
        boolean stale = keys == null || Duration.between(fetchedAt, now).compareTo(CACHE_TTL) > 0;
        boolean mayRefetch = Duration.between(fetchedAt, now).compareTo(MIN_REFETCH) > 0;
        if (stale || (unknownKid && mayRefetch)) {
            String json = jwksSource.get();
            if (json == null || json.isBlank()) {
                if (keys != null) return keys;
                throw new IllegalArgumentException("couldn't load Google's signing keys");
            }
            keys = Jwks.setParser().build().parse(json);
            fetchedAt = now;
        }
        return keys;
    }
}
