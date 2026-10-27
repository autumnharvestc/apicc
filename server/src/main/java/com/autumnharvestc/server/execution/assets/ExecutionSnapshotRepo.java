package com.autumnharvestc.server.execution.assets;

import com.autumnharvestc.server.execution.ExecutionDtos.ExecutionSnapshot;
import org.springframework.stereotype.Repository;
import java.util.Optional;
import com.autumnharvestc.server.execution.ExecutionDtos.ProjectAssets;
import com.autumnharvestc.server.store.IdGeneration;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import java.sql.PreparedStatement;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Objects;

@Repository
public class ExecutionSnapshotRepo {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final IdGeneration ids;
    public ExecutionSnapshotRepo(JdbcTemplate jdbc, ObjectMapper json, IdGeneration ids) { this.jdbc = jdbc; this.json = json; this.ids = ids; }

    /** Internal storage seam; members must go through ExecutionSnapshotService authorization. */
    public ExecutionSnapshot insert(long userId, ProjectAssets assets) {
        final String bytes;
        try { bytes = json.writeValueAsString(assets); }
        catch (JsonProcessingException e) { throw new IllegalStateException("Cannot encode fixed snapshot", e); }
        long id;
        var now = OffsetDateTime.now(ZoneOffset.UTC);
        if (ids.appAssigned()) {
            id = ids.nextId();
            jdbc.update("INSERT INTO execution_snapshots (id,workspace_id,project_id,created_by,created_at,assets_json) VALUES (?,?,?,?,?,?)",
                id, Long.parseLong(assets.workspaceId()), Long.parseLong(assets.projectId()), userId, now, bytes);
        } else {
            var keys = new GeneratedKeyHolder();
            jdbc.update(connection -> {
                PreparedStatement statement = connection.prepareStatement("INSERT INTO execution_snapshots (workspace_id,project_id,created_by,created_at,assets_json) VALUES (?,?,?,?,?)", new String[]{"id"});
                statement.setLong(1, Long.parseLong(assets.workspaceId())); statement.setLong(2, Long.parseLong(assets.projectId()));
                statement.setLong(3, userId); statement.setObject(4, now); statement.setString(5, bytes); return statement;
            }, keys);
            id = Objects.requireNonNull(keys.getKey()).longValue();
        }
        return new ExecutionSnapshot(String.valueOf(id), String.valueOf(userId), assets);
    }
    public Optional<ExecutionSnapshot> find(long id) {
        return jdbc.query("SELECT id,created_by,assets_json FROM execution_snapshots WHERE id = ?", (row, index) -> {
            try { return new ExecutionSnapshot(String.valueOf(row.getLong("id")), String.valueOf(row.getLong("created_by")), json.readValue(row.getString("assets_json"), ProjectAssets.class)); }
            catch (JsonProcessingException e) { throw new IllegalStateException("Stored snapshot is invalid", e); }
        }, id).stream().findFirst();
    }
}
