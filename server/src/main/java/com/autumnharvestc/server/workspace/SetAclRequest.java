package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.AclRole;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

/**
 * 置项目 ACL 载荷（规格 m3 §3.3：PUT …/acl {userId, role}）。
 * role ∈ NONE/VIEWER/EDITOR/ADMIN：NONE=显式拒之门外；删行（DELETE）=恢复继承。
 */
public record SetAclRequest(
        @NotBlank(message = "不能为空")
        String userId,

        @NotNull(message = "不能为空")
        AclRole role) {
}
