package com.autumnharvestc.server.content;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 内容同步端点（规格 m3 §3.4，任务 5）：tree / files 批量取 / PUT 单文件 / batch 推送 / DELETE。
 * 权限面：工作区守卫（WorkspaceGuard.requireMember）+ 路径级有效角色判定在 ContentService。
 * 文件路径经 {*filePath} 捕获（含前导斜杠，跨多段）——还原为相对路径后交服务层校验。
 */
@RestController
public class ContentController {

    private final ContentService content;

    public ContentController(ContentService content) {
        this.content = content;
    }

    /** 200 {workspaceId, rootVersion, files[], projects[]}；无读权项目子树整体不出现。 */
    @GetMapping("/api/v1/workspaces/{id}/tree")
    public TreeView tree(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                         @PathVariable String id) {
        return content.tree(caller, id);
    }

    /** 200 {files[], missing[]}；≤200 路径/批（超限 400 batch_too_large）。 */
    @GetMapping("/api/v1/workspaces/{id}/files")
    public FilesBatchView files(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                @PathVariable String id,
                                @RequestParam String paths) {
        return content.readFiles(caller, id, paths);
    }

    /** 201 新建/变更；200 同 hash 幂等（裁定 D）；409 version_conflict 带现状；400/403 见服务层。 */
    @PutMapping("/api/v1/workspaces/{id}/files/{*filePath}")
    public ResponseEntity<PutResult> put(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                         @PathVariable String id,
                                         @PathVariable String filePath,
                                         @Valid @RequestBody PutFileRequest request) {
        PutOutcome outcome = content.putFile(caller, id, relative(filePath), request);
        return outcome.created()
                ? ResponseEntity.status(HttpStatus.CREATED).body(outcome.body())
                : ResponseEntity.ok(outcome.body());
    }

    /** 200 {results[]} 逐文件 pushed/conflict/forbidden/invalid/failed（部分成功，D8）。 */
    @PostMapping("/api/v1/workspaces/{id}/files/batch")
    public BatchResultView batch(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                 @PathVariable String id,
                                 @RequestBody BatchPushRequest request) {
        return content.batchPush(caller, id, request);
    }

    /** 204 删除成功；409 version_conflict；404 file_not_found；400/403 同 PUT。 */
    @DeleteMapping("/api/v1/workspaces/{id}/files/{*filePath}")
    public ResponseEntity<Void> delete(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                       @PathVariable String id,
                                       @PathVariable String filePath,
                                       @RequestParam long baseVersion) {
        content.deleteFile(caller, id, relative(filePath), baseVersion);
        return ResponseEntity.noContent().build();
    }

    /** {*filePath} 捕获值含前导斜杠 → 还原为相对工作区根的路径。 */
    private static String relative(String captured) {
        return captured.startsWith("/") ? captured.substring(1) : captured;
    }
}
