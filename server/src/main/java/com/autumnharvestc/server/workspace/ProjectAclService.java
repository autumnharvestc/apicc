package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.store.AclRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.UserRepo;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * 项目 ACL 用例（规格 m3 §3.3）：清单/置行/删行，ADMIN+（裁定口径：按工作区角色判——
 * D5「ADMIN 管理成员与项目 ACL」为工作区级语义；项目级 ACL 行仅影响内容面的有效角色）。
 * 裁定 A：ACL 按 projectId 寻址，服务端不做 projectId→内容目录校验——任意 id 可预设，
 * tree 面按内容推导后再过滤（任务 5）。NONE 行=显式拒之门外；DELETE 行=恢复继承（幂等）。
 * 目标用户须存在（404 user_not_found），但无需是工作区成员（ACL 可向非成员授予项目级访问，D5）。
 */
@Service
public class ProjectAclService {

    private final AclRepo acl;
    private final UserRepo users;
    private final WorkspaceGuard guard;

    public ProjectAclService(AclRepo acl, UserRepo users, WorkspaceGuard guard) {
        this.acl = acl;
        this.users = users;
        this.guard = guard;
    }

    /** ACL 清单（规格 §3.3：[{userId, role}]）。 */
    public List<AclEntryView> list(UserAccount caller, String workspaceId, String projectId) {
        guard.requireAdmin(workspaceId, caller);
        return acl.listByProject(workspaceId, projectId).stream()
                .map(AclEntryView::of)
                .toList();
    }

    /** 置/覆盖 ACL 行（规格 §3.3：PUT {userId, role}）。 */
    public AclEntryView put(UserAccount caller, String workspaceId, String projectId, SetAclRequest request) {
        guard.requireAdmin(workspaceId, caller);
        UserAccount target = users.findById(request.userId())
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "目标用户不存在"));
        acl.upsert(workspaceId, projectId, target.id(), request.role());
        return new AclEntryView(target.id(), request.role());
    }

    /** 删 ACL 行=恢复工作区角色继承（规格 §3.3 括注；DELETE 同路径 ?userId=；幂等 204）。 */
    public void delete(UserAccount caller, String workspaceId, String projectId, String targetUserId) {
        guard.requireAdmin(workspaceId, caller);
        acl.delete(workspaceId, projectId, targetUserId);
    }
}
