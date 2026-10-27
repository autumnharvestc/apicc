package com.autumnharvestc.server.execution.assets;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.ExecutionDtos.*;
import org.springframework.web.bind.annotation.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.cfg.CoercionAction;
import com.fasterxml.jackson.databind.cfg.CoercionInputShape;
import com.fasterxml.jackson.databind.type.LogicalType;
import org.springframework.http.HttpStatus;

@RestController
@RequestMapping("/api/v1/workspaces/{ws}/projects/{project}")
public class ProjectAssetsController {
    private final ProjectAssetsService assets;
    private final ExecutionSnapshotService snapshots;
    private final ObjectMapper controlJson;
    public ProjectAssetsController(ProjectAssetsService assets, ExecutionSnapshotService snapshots) {
        this.assets = assets; this.snapshots = snapshots;
        controlJson = JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).disable(MapperFeature.ALLOW_COERCION_OF_SCALARS).build();
        controlJson.coercionConfigFor(LogicalType.Textual)
            .setCoercion(CoercionInputShape.Integer, CoercionAction.Fail)
            .setCoercion(CoercionInputShape.Float, CoercionAction.Fail)
            .setCoercion(CoercionInputShape.Boolean, CoercionAction.Fail);
    }
    @GetMapping("/assets")
    public ProjectAssets get(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable String ws, @PathVariable String project) {
        return assets.get(caller, ws, project);
    }
    @PutMapping("/assets")
    public ProjectAssets put(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable String ws, @PathVariable String project, @RequestBody JsonNode delta) {
        return assets.put(caller, ws, project, decode(delta, AssetDelta.class));
    }
    @PostMapping("/execution-snapshots")
    @ResponseStatus(org.springframework.http.HttpStatus.CREATED)
    public ExecutionSnapshot snapshot(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable String ws, @PathVariable String project, @RequestBody JsonNode request) {
        return snapshots.create(caller, ws, project, decode(request, SnapshotRequest.class));
    }
    private <T> T decode(JsonNode input, Class<T> type) {
        try { return controlJson.treeToValue(input, type); }
        catch (JsonProcessingException e) { throw ProjectAssetsService.error(HttpStatus.BAD_REQUEST, "validation_failed", "控制字段类型错误或包含未知字段"); }
    }
}
