package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 成员端点（规格 m3 §3.2）：清单/添加变更角色/移除。
 * 角色规则（裁定 C）在 MemberService；401 由 AuthFilter 先行，403/404 见 WorkspaceGuard/MemberService。
 */
@RestController
public class MemberController {

    private final MemberService members;

    public MemberController(MemberService members) {
        this.members = members;
    }

    /** 200 [{userId, username, displayName, role}]（成员可读）；403 非成员。 */
    @GetMapping("/api/v1/workspaces/{id}/members")
    public List<MemberView> list(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                 @PathVariable String id) {
        return members.list(caller, id);
    }

    /** 200 成员视图（变更后角色）；403 owner_immutable/requires_owner/forbidden；404 user_not_found。 */
    @PutMapping("/api/v1/workspaces/{id}/members/{userId}")
    public MemberView put(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                          @PathVariable String id,
                          @PathVariable String userId,
                          @Valid @RequestBody SetMemberRoleRequest request) {
        return members.put(caller, id, userId, request);
    }

    /** 204 移除；403 owner_immutable/forbidden；404 member_not_found。 */
    @DeleteMapping("/api/v1/workspaces/{id}/members/{userId}")
    public ResponseEntity<Void> delete(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                       @PathVariable String id,
                                       @PathVariable String userId) {
        members.delete(caller, id, userId);
        return ResponseEntity.noContent().build();
    }
}
