package com.autumnharvestc.server.workspace;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * POST /api/v1/workspaces/{id}/project-mapping 响应（计划 C 任务 1）：{mappings: [...]}
 * 逐条目部分成功（与 files/batch 行级呈现同构——单行不建实体不整批失败）。null 字段不序列化。行形状：
 * <ul>
 *   <li>解析/建成：{group, project, groupId, projectId, created}——created=true 仅本轮新建过实体；</li>
 *   <li>缺失未建（createIfMissing=false，任意角色）：{group, project, missing:true}（不建、不报错）；</li>
 *   <li>请求创建但权限不足（createIfMissing=true 且非 ADMIN+）：{group, project, forbidden:true}
 *       （裁定：行级 403 语义保持批量部分成功，不整批 403——审查留痕）。</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MappingView(List<Row> mappings) {

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Row(String group, String project, String groupId, String projectId,
                      Boolean created, Boolean missing, Boolean forbidden) {
    }
}
