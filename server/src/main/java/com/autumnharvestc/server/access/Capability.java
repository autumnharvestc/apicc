package com.autumnharvestc.server.access;

/** Finite collaboration capability identifiers; role policy is resolved by Java. */
public enum Capability {
    HISTORY_READ("history.read"), HISTORY_PUBLISH("history.publish"), SCRIPT_EDIT("script.edit"),
    CREDENTIAL_MANAGE("credential.manage"), TASK_EXECUTE("task.execute"),
    PUBLICATION_MANAGE("publication.manage"), MOCK_MANAGE("mock.manage"),
    MOCK_LOGS_READ("mock.logs.read"), AUDIT_READ("audit.read");

    private final String code;
    Capability(String code) { this.code = code; }
    @com.fasterxml.jackson.annotation.JsonValue
    public String code() { return code; }
}
