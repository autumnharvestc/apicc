package com.autumnharvestc.server.content;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * POST files/batch 响应（规格 m3 §3.4）：results 逐文件 {path, status, version?, currentVersion?, message?}。
 * status 口径：pushed / conflict / forbidden / invalid + failed（§2 D8「逐文件结果 failed」的载体——
 * 单文件落盘失败不整批 500，以 failed 行呈现，联调轨对齐口径）。null 字段不出序列化。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record BatchResultView(List<FileResult> results) {

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record FileResult(String path, String status, Long version, Long currentVersion, String message) {
    }
}
