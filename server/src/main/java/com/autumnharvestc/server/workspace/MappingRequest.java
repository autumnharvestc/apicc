package com.autumnharvestc.server.workspace;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * POST /api/v1/workspaces/{id}/project-mapping 载荷（计划 C 任务 1，迁移桥）：
 * {entries: [{group, project, createIfMissing}]}——本地名称目录二元组
 * （groups/&lt;组&gt;/projects/&lt;项目&gt;）+ 按需建开关。
 * 名称约束与组织 API 一致（@NotBlank @Size(max=64)，400 validation_failed 由
 * GlobalExceptionHandler 的 MethodArgumentNotValidException 统一映射）；@Valid 级联逐条校验，
 * 容器元素 @NotNull 钉住 [null]（属性级 @Valid 对 null 容器元素不级联——审查修复①，否则 null 流入
 * 服务层 NPE 落 500）。
 * createIfMissing 缺省按 false（只解析不建）；批量上限在服务层（batch_too_large，与 files/batch 同款）。
 */
public record MappingRequest(@NotEmpty @Valid List<@NotNull Item> entries) {

    /** 单条映射请求：createIfMissing=null 视为 false（Boolean 装箱，缺字段不报校验错）。 */
    public record Item(@NotBlank @Size(max = 64) String group,
                       @NotBlank @Size(max = 64) String project,
                       Boolean createIfMissing) {
    }
}
