package com.autumnharvestc.server.admin;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** 账号管理端点（规格§2）：全部仅 SUPERADMIN（守卫在 Service）。 */
@RestController
@RequestMapping("/api/v1/admin/users")
public class AdminController {

    private final AdminService admin;

    public AdminController(AdminService admin) {
        this.admin = admin;
    }

    /** 账号安全视图：只投影 id/username/displayName/role/disabled/createdAt，password_hash 不出服务层。 */
    public record AdminUserView(String id, String username, String displayName, String role, boolean disabled, String createdAt) {
        public static AdminUserView of(UserAccount u) {
            return new AdminUserView(u.id(), u.username(), u.displayName(), u.role().name(), u.disabled(), u.createdAt().toString());
        }
    }

    @GetMapping
    public List<AdminUserView> list(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller) {
        return admin.list(caller).stream().map(AdminUserView::of).toList();
    }

    @PostMapping
    public ResponseEntity<AdminUserView> create(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                                @Valid @RequestBody AdminRequests.CreateUserRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(AdminUserView.of(admin.create(caller, request)));
    }

    @PostMapping("/{id}/password-reset")
    public ResponseEntity<Void> resetPassword(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                              @PathVariable String id,
                                              @Valid @RequestBody AdminRequests.ResetPasswordRequest request) {
        admin.resetPassword(caller, id, request.newPassword());
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{id}/disable")
    public ResponseEntity<Void> disable(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable String id) {
        admin.setDisabled(caller, id, true);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{id}/enable")
    public ResponseEntity<Void> enable(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller, @PathVariable String id) {
        admin.setDisabled(caller, id, false);
        return ResponseEntity.noContent().build();
    }

    @PutMapping("/{id}/workspace-role")
    public ResponseEntity<Void> setWorkspaceRole(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                                 @PathVariable String id,
                                                 @Valid @RequestBody AdminRequests.SetWorkspaceRoleRequest request) {
        admin.setWorkspaceRole(caller, id, request.workspaceId(), request.role());
        return ResponseEntity.noContent().build();
    }
}
