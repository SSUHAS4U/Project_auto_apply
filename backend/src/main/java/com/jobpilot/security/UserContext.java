package com.jobpilot.security;

import com.jobpilot.service.NotFoundException;

import java.util.UUID;

/** Holds the authenticated user's id for the current request thread. */
public final class UserContext {

    private static final ThreadLocal<UUID> CURRENT = new ThreadLocal<>();

    private UserContext() {}

    public static void set(UUID userId) {
        CURRENT.set(userId);
    }

    public static UUID get() {
        return CURRENT.get();
    }

    /** Current user id or 401-style error if missing (should be guarded by the filter). */
    public static UUID require() {
        UUID id = CURRENT.get();
        if (id == null) throw new NotFoundException("no authenticated user");
        return id;
    }

    public static void clear() {
        CURRENT.remove();
    }
}
