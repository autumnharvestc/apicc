package com.autumnharvestc.server.execution.materials;

import java.util.List;
import java.util.Optional;

/** Storage strategy handles encrypted envelopes only; deployment key bytes never enter this interface. */
public interface ProjectCredentialStore {
    record Envelope(long workspaceId,long projectId,String refId,long version,String keyId,byte[] nonce,byte[] ciphertext) {}
    Optional<Envelope> find(long workspaceId,long projectId,String refId);
    List<Envelope> list(long workspaceId,long projectId);
    void save(Envelope envelope);
}
