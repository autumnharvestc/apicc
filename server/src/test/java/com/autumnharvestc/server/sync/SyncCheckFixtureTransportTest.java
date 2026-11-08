package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.collaboration.runtime.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import static org.assertj.core.api.Assertions.assertThat;

/** A failed caller must not take down the shared transport used by later tests. */
class SyncCheckFixtureTransportTest {
    private final ObjectMapper json = new ObjectMapper();

    @ParameterizedTest
    @ValueSource(strings = {"interrupted-upload", "malformed-json"})
    void rejectedTransportLeavesTheSameProcessAvailableForTheNextRealRead(String scenario) throws Exception {
        try (var node = new SyncCheckHttpFixture.Node()) {
            var properties = new RuntimeProperties();
            properties.setEnabled(true);
            properties.setBaseUrl(node.info.path("url").asText());
            properties.setSecretFile(node.info.path("secretFile").asText());
            var client = new CollaborationRuntimeClient(properties, new RuntimeProtocol(json), json);
            try {
                read(client, node.info);
                var endpoint = URI.create(node.info.path("url").asText());
                try (var socket = new Socket("127.0.0.1", endpoint.getPort())) {
                    socket.setSoTimeout(5000);
                    var out = socket.getOutputStream();
                    if (scenario.equals("interrupted-upload")) {
                        out.write(("POST /rpc HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n"
                            + "Expect: 100-continue\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                        assertThat(new String(socket.getInputStream().readNBytes(25), StandardCharsets.US_ASCII))
                            .isEqualTo("HTTP/1.1 100 Continue\r\n\r\n");
                        out.write("100\r\n{".getBytes(StandardCharsets.US_ASCII));
                    } else {
                        out.write("POST /rpc HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 1\r\n\r\n{"
                            .getBytes(StandardCharsets.US_ASCII));
                    }
                    out.flush();
                    socket.shutdownOutput();
                    // Wait for the server to finish this connection before the next request.
                    try {
                        var reply = new String(socket.getInputStream().readAllBytes(), StandardCharsets.US_ASCII);
                        if (scenario.equals("malformed-json")) assertThat(reply).startsWith("HTTP/1.1 400");
                    } catch (SocketException disconnected) {
                        if (!scenario.equals("interrupted-upload")) throw disconnected;
                    }
                }
                assertThat(node.process.isAlive()).as("Same fixture process; stderr: %s", node.directory.resolve("node-stderr.log")).isTrue();
                read(client, node.info);
            } finally {
                client.close();
            }
        }
    }

    private void read(CollaborationRuntimeClient client, JsonNode info) {
        long deadline = System.currentTimeMillis() + 15000;
        var input = json.createObjectNode().put("formatVersion", 1).put("deadlineAtMs", deadline);
        input.set("source", json.createObjectNode().put("formatVersion", 1)
            .put("id", UUID.randomUUID().toString()).put("revision", "1")
            .put("moduleId", "00000000-0000-4000-8000-000000000071").put("kind", "url")
            .put("url", info.path("origin").asText() + "/fast"));
        input.set("budget", json.createObjectNode().put("connectTimeoutMs", 1000).put("maxAttempts", 1)
            .put("maxSourceBytes", 65536).put("gitDiskThresholdBytes", 33554432));
        ObjectNode payload = json.createObjectNode();
        payload.set("input", input);
        payload.set("context", json.createObjectNode().put("workspaceId", "71").put("projectId", "72")
            .put("sourceRevision", "1").put("authorizationGeneration", "1")
            .put("invocationId", UUID.randomUUID().toString()).put("projectConcurrency", 1).put("hostConcurrency", 4));
        payload.set("material", json.createObjectNode().put("leaseId", UUID.randomUUID().toString()).put("identity", "a".repeat(64)));
        payload.set("network", json.createObjectNode().put("kind", "direct").put("revision", "0"));
        assertThat(client.call("sync-read", payload, deadline, 1048576).path("rawText").asText())
            .isEqualTo(info.path("rawText").asText());
    }
}
