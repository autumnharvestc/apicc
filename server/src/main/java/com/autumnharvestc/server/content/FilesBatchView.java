package com.autumnharvestc.server.content;

import java.util.List;

/**
 * GET files?paths= 响应（规格 m3 §3.4）：命中文件带文本内容/版本/hash；
 * 不存在、无读权或非法的路径一律进 missing（部分成功语义，不整批失败）。
 */
public record FilesBatchView(List<FileContent> files, List<String> missing) {

    /** content 为按 UTF-8 解码的文本（服务端只当字节管家，二进制内容不在本契约保证范围）。 */
    public record FileContent(String path, String content, long version, String hash) {
    }
}
