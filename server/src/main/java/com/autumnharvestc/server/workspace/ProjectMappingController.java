package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 迁移映射桥端点（计划 C 任务 1）：POST /api/v1/workspaces/{id}/project-mapping。
 * 桌面端迁移向导把本地名称目录（groups/&lt;组&gt;/projects/&lt;项目&gt;）换算成服务端实体 id
 * （&lt;projectId&gt;/...）后再推 batch——客户端不维护持久映射表（无状态、可重放）。
 * 401 由 AuthFilter 先行；守卫与行级语义见 ProjectMappingService/MappingView：
 * 200 {mappings[]}（部分成功）；403 forbidden 非成员；404 workspace_not_found；
 * 400 validation_failed 名称校验 / batch_too_large 超 200 条。
 */
@RestController
public class ProjectMappingController {

    private final ProjectMappingService mappings;

    public ProjectMappingController(ProjectMappingService mappings) {
        this.mappings = mappings;
    }

    /** 200 {mappings:[{group, project, groupId, projectId, created} | 缺失/越权行]}；逐行形状见 MappingView。 */
    @PostMapping("/api/v1/workspaces/{id}/project-mapping")
    public MappingView map(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                           @PathVariable String id,
                           @Valid @RequestBody MappingRequest request) {
        return mappings.map(caller, id, request);
    }
}
