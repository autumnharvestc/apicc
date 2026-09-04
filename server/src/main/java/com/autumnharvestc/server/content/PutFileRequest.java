package com.autumnharvestc.server.content;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;

/**
 * PUT files/{path} 载荷（规格 m3 §3.4）：{content, baseVersion}；新文件 baseVersion=0。
 * content 允许空串（空文件合法），但不允许缺失。
 */
public record PutFileRequest(@NotNull String content, @NotNull @PositiveOrZero Long baseVersion) {
}
