package com.autumnharvestc.server.content;

import com.autumnharvestc.server.core.ApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Comparator;
import java.util.stream.Stream;

/**
 * 工作区内容目录管理（规格 m3 §2 D6：server-data/workspaces/&lt;wsId&gt;/，与本地工作区同构的文本树）。
 * 任务 4 只用目录生命周期（建区建目录 / 删区递归删）；任务 5 内容同步复用 {@link #workspaceRoot}。
 * 路径约束：workspaceId 先 normalize 再校验仍落在 workspaces 根内（防路径穿越写逃）。
 */
@Component
public class WorkspaceContentStore {

    private final Path workspacesRoot;

    public WorkspaceContentStore(@Value("${apicc.server.data-dir:./server-data}") String dataDir) {
        this.workspacesRoot = Paths.get(dataDir, "workspaces").normalize();
    }

    /** 工作区内容根目录；id 形态异常（穿越/含段）按工作区不存在处理，不泄露细节。 */
    public Path workspaceRoot(String workspaceId) {
        Path root = workspacesRoot.resolve(workspaceId).normalize();
        if (!root.startsWith(workspacesRoot)) {
            throw new ApiException(HttpStatus.NOT_FOUND, "workspace_not_found", "工作区不存在");
        }
        return root;
    }

    /** 建区时建立内容目录（先盘后库：目录失败则无 DB 写入）。 */
    public void createWorkspaceDir(String workspaceId) {
        try {
            Files.createDirectories(workspaceRoot(workspaceId));
        } catch (IOException ex) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "io_error", "创建工作区内容目录失败");
        }
    }

    /**
     * 删区时递归删除内容目录（裁定 D：库表行清完后执行）。
     * 目录不存在视为已清理（幂等）；删除中途失败 → 500 content_delete_failed，
     * 此时 DB 记录已删、可能残留部分目录——取舍见任务 4 报告（可重试 DELETE 目录级脚本兜底）。
     */
    public void deleteWorkspaceDirRecursively(String workspaceId) {
        Path root = workspaceRoot(workspaceId);
        if (!Files.exists(root)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.delete(path);
                } catch (IOException ex) {
                    throw new UncheckedIOException(ex);
                }
            });
        } catch (IOException | UncheckedIOException ex) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "content_delete_failed", "工作区记录已删除，但内容目录清理失败");
        }
    }

    // ---- 以下为任务 5 内容同步新增：相对路径 → 落盘的文件级操作 ----

    /**
     * 相对路径解析到工作区根内（第二层穿越防御；第一层为 ProjectPaths.validate 的字符规则）。
     * resolve+normalize 后必须仍以工作区根为前缀——触发即校验缺口，按非法路径拒绝。
     */
    public Path resolveInRoot(Path root, String relativePath) {
        try {
            Path target = root.resolve(relativePath).normalize();
            if (!target.startsWith(root)) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid", "非法路径");
            }
            return target;
        } catch (java.nio.file.InvalidPathException ex) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid", "非法路径");
        }
    }

    /** 读文件字节；路径不存在或不是普通文件返回 null（调用方转 missing 语义）。 */
    public byte[] readFile(Path root, String relativePath) throws IOException {
        Path target = resolveInRoot(root, relativePath);
        if (!Files.isRegularFile(target)) {
            return null;
        }
        return Files.readAllBytes(target);
    }

    /** 写文件字节（自动建父目录；CREATE+TRUNCATE 覆盖写）。IO 异常上抛，由服务层回滚版本并转 io_error。 */
    public void writeFile(Path root, String relativePath, byte[] bytes) throws IOException {
        Path target = resolveInRoot(root, relativePath);
        if (target.getParent() != null) {
            Files.createDirectories(target.getParent());
        }
        Files.write(target, bytes);
    }

    /** 删文件；不存在视为已删（幂等）。IO 异常上抛，由服务层恢复版本行并转 io_error。 */
    public boolean deleteFile(Path root, String relativePath) throws IOException {
        return Files.deleteIfExists(resolveInRoot(root, relativePath));
    }

    /** 落盘文件真实字节数（裁定 A：tree 的 size 口径）；文件缺失/不可 stat 时按 0。 */
    public long sizeOfFile(Path root, String relativePath) {
        try {
            return Files.size(resolveInRoot(root, relativePath));
        } catch (IOException ex) {
            return 0L;
        }
    }
}
