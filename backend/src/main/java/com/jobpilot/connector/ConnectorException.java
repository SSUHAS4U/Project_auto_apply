package com.jobpilot.connector;

public class ConnectorException extends RuntimeException {
    public ConnectorException(String message, Throwable cause) {
        super(message, cause);
    }
    public ConnectorException(String message) {
        super(message);
    }
}
