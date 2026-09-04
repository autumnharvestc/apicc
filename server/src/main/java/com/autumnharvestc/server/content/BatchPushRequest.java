package com.autumnharvestc.server.content;

import java.util.List;

/**
 * POST files/batch 载荷（规格 m3 §3.4）：{files: [{path, content, baseVersion}]} ≤200。
 * 不做 bean 级逐项校验——坏项在服务层按「invalid」进结果行，保持部分成功语义（迁移/推送面）。
 */
public record BatchPushRequest(List<Item> files) {

    public record Item(String path, String content, Long baseVersion) {
    }
}
