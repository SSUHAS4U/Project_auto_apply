package com.jobpilot.service.mail;

/** A single in-memory email attachment (e.g. a generated cover-letter PDF or resume bytes). */
public record MailAttachment(String name, byte[] bytes) {}
