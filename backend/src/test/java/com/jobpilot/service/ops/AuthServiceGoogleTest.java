package com.jobpilot.service.ops;

import com.jobpilot.config.JobPilotProperties;
import com.jobpilot.domain.AppUser;
import com.jobpilot.repository.*;
import com.jobpilot.security.GoogleIdTokenVerifier;
import com.jobpilot.security.JwtService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

/**
 * Google sign-in must not become a side door around closed sign-up. The verifier is stubbed —
 * its own test proves tokens are checked — so these tests pin only the ACCOUNT rules.
 */
class AuthServiceGoogleTest {

    private final AppUserRepository users = mock(AppUserRepository.class);
    private final ProfileRepository profiles = mock(ProfileRepository.class);
    private final JwtService jwt = mock(JwtService.class);
    private final GoogleIdTokenVerifier google = mock(GoogleIdTokenVerifier.class);
    private AuthService auth;

    @BeforeEach
    void setUp() {
        JobPilotProperties props = new JobPilotProperties();
        auth = new AuthService(users, profiles, mock(ApplicationRepository.class), mock(SavedJobRepository.class),
                mock(NotificationRepository.class), jwt, props, google);
        when(jwt.issue(any(), anyString())).thenReturn("signed.jwt");
        when(google.verify("cred")).thenReturn(
                new GoogleIdTokenVerifier.GoogleIdentity("sub-1", "person@example.com", "Person"));
        when(users.saveAndFlush(any())).thenAnswer(i -> { AppUser u = i.getArgument(0); u.setId(UUID.randomUUID()); return u; });
    }

    private static AppUser user(String email) {
        AppUser u = new AppUser();
        u.setId(UUID.randomUUID());
        u.setEmail(email);
        u.setRole("USER");
        return u;
    }

    @Test
    void anExistingAccountSignsInByItsVerifiedEmail() {
        when(users.findByEmailIgnoreCase("person@example.com")).thenReturn(Optional.of(user("person@example.com")));
        Map<String, Object> out = auth.google("cred");
        assertEquals("signed.jwt", out.get("token"));
        verify(users, never()).saveAndFlush(any());
    }

    @Test
    void aStrangerIsRefusedWhileSignUpIsClosed() {
        when(users.findByEmailIgnoreCase(anyString())).thenReturn(Optional.empty());
        when(users.count()).thenReturn(1L);
        SecurityException e = assertThrows(SecurityException.class, () -> auth.google("cred"));
        assertTrue(e.getMessage().contains("person@example.com"), e.getMessage());
        assertTrue(e.getMessage().contains("invite only"), e.getMessage());
        verify(users, never()).saveAndFlush(any());
    }

    @Test
    void theFirstAccountCanBeCreatedWithGoogle() {
        when(users.findByEmailIgnoreCase(anyString())).thenReturn(Optional.empty());
        when(users.count()).thenReturn(0L);
        when(profiles.findByUserId(any())).thenReturn(Optional.empty());
        Map<String, Object> out = auth.google("cred");
        assertEquals("signed.jwt", out.get("token"));
        verify(users).saveAndFlush(argThat(u -> "person@example.com".equals(u.getEmail())
                && u.getPasswordHash() != null && !u.getPasswordHash().isBlank()));
    }

    @Test
    void openSignUpAdmitsANewGoogleAccount() {
        ReflectionTestUtils.setField(auth, "registrationOpen", true);
        when(users.findByEmailIgnoreCase(anyString())).thenReturn(Optional.empty());
        when(users.count()).thenReturn(5L);
        when(profiles.findByUserId(any())).thenReturn(Optional.empty());
        assertEquals("signed.jwt", auth.google("cred").get("token"));
    }

    @Test
    void publicConfigReportsWhetherSignUpIsOpen() {
        when(google.clientId()).thenReturn("id.apps.googleusercontent.com");
        when(users.count()).thenReturn(3L);
        assertEquals(Map.of("googleClientId", "id.apps.googleusercontent.com", "registrationOpen", false),
                auth.publicConfig());
        when(users.count()).thenReturn(0L);
        assertEquals(true, auth.publicConfig().get("registrationOpen"));
    }
}
