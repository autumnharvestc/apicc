package com.autumnharvestc.server.access;

import com.autumnharvestc.server.core.PermissionService;
import com.autumnharvestc.server.store.AclRepo;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.UserRepo;
import com.autumnharvestc.server.store.ProjectRepo;
import com.autumnharvestc.server.core.Role;
import org.springframework.stereotype.Service;
import java.util.Set;

/** Full current-account/member/project decision, with role floors and scoped capability policy. */
@Service
public class ProjectAccessService {
    private final PermissionService permissions;
    private final MembershipRepo memberships;
    private final AclRepo acl;
    private final UserRepo users;
    private final ProjectRepo projects;
    private final AccessRepo records;

    public ProjectAccessService(PermissionService permissions, MembershipRepo memberships, AclRepo acl, UserRepo users, ProjectRepo projects, AccessRepo records) {
        this.permissions = permissions;
        this.memberships = memberships;
        this.acl = acl;
        this.users = users;
        this.projects = projects;
        this.records = records;
    }

    public ProjectAccessView resolve(Long userId, Long workspaceId, Long projectId) {
        var workspaceRole = memberships.findRole(workspaceId, userId);
        var override = acl.findRole(workspaceId, projectId, userId);
        boolean enabled = users.findById(userId).map(u -> !u.disabled()).orElse(false);
        boolean projectInWorkspace = projectId == null || projects.find(projectId).filter(p -> p.workspaceId().equals(workspaceId)).isPresent();
        var role = enabled && workspaceRole.isPresent() && projectInWorkspace
                ? permissions.effectiveRole(workspaceId, userId, projectId) : java.util.Optional.<Role>empty();
        Set<Capability> granted = role.map(r -> {
            var allowed = java.util.EnumSet.noneOf(Capability.class);
            for (Capability capability : Capability.values()) if (evaluate(userId, workspaceId, projectId, r, capability).effective()) allowed.add(capability);
            return Set.copyOf(allowed);
        }).orElse(Set.of());
        return new ProjectAccessView(enabled,
                workspaceRole.isPresent(), workspaceRole, override,
                acl.findState(workspaceId, projectId, userId).orElse("inherited"),
                role, granted, projectId == null ? records.memberRevision(workspaceId, userId) : records.projectRevision(workspaceId,projectId),
                records.membershipEpoch(workspaceId,userId),projectId==null?0:records.responsibilityEpoch(workspaceId,projectId,userId),
                !enabled?"account-unavailable":workspaceRole.isEmpty()?"not-member":!projectInWorkspace?"project-not-found":
                        acl.findState(workspaceId,projectId,userId).filter("pending-confirmation"::equals).isPresent()?"pending-confirmation":role.isEmpty()?"explicit-none":"allowed");
    }

    public record CapabilityRow(String code, String mode, boolean effective, String source, String roleFloor, String reason) {}

    public java.util.List<CapabilityRow> capabilityRows(Long userId, Long workspaceId, Long projectId) {
        var decision = resolve(userId, workspaceId, projectId);
        var local = records.capabilities(workspaceId, projectId == null ? 0 : projectId, userId);
        return java.util.Arrays.stream(Capability.values()).map(capability -> decision.effectiveRole()
                .map(role -> evaluate(userId, workspaceId, projectId, role, capability))
                .orElse(new CapabilityRow(capability.code(), local.getOrDefault(capability.code(), "inherit"), false, "unavailable", floor(capability), "unavailable"))).toList();
    }

    private CapabilityRow evaluate(Long userId, Long workspaceId, Long projectId, Role role, Capability capability) {
        String code = capability.code();
        var workspaceMember = records.capabilities(workspaceId, 0, userId);
        var projectMember = projectId == null ? java.util.Map.<String,String>of() : records.capabilities(workspaceId, projectId, userId);
        String local = (projectId == null ? workspaceMember : projectMember).getOrDefault(code, "inherit");
        if (role == Role.VIEWER && floor(capability).equals("EDITOR"))
            return new CapabilityRow(code, local, false, "role-floor", floor(capability), "role-floor");
        if ("deny".equals(workspaceMember.get(code)) || "deny".equals(projectMember.get(code)))
            return new CapabilityRow(code, local, false, "explicit-deny", floor(capability), "explicit-deny");
        if ("allow".equals(projectMember.get(code))) return new CapabilityRow(code, local, true, "project-member", floor(capability), "allowed");
        if ("allow".equals(workspaceMember.get(code))) return new CapabilityRow(code, local, true, "workspace-member", floor(capability), "allowed");
        String projectDefault = projectId == null ? "inherit" : records.defaults(workspaceId, projectId).getOrDefault(code, "inherit");
        if (!projectDefault.equals("inherit")) return new CapabilityRow(code, local, projectDefault.equals("allow"), "project-default", floor(capability), projectDefault);
        String workspaceDefault = records.defaults(workspaceId, 0).getOrDefault(code, "inherit");
        if (!workspaceDefault.equals("inherit")) return new CapabilityRow(code, local, workspaceDefault.equals("allow"), "workspace-default", floor(capability), workspaceDefault);
        return new CapabilityRow(code, local, defaults(role).contains(capability), "builtin-role", floor(capability), "builtin-role");
    }

    private String floor(Capability capability) {
        return switch (capability) {
            case HISTORY_READ, MOCK_LOGS_READ, AUDIT_READ -> "VIEWER";
            default -> "EDITOR";
        };
    }

    private Set<Capability> defaults(Role role) {
        return switch (role) {
            case VIEWER -> Set.of(Capability.HISTORY_READ);
            case EDITOR -> Set.of(Capability.HISTORY_READ, Capability.HISTORY_PUBLISH, Capability.SCRIPT_EDIT,
                    Capability.CREDENTIAL_MANAGE, Capability.TASK_EXECUTE, Capability.SYNC_CHECK, Capability.SYNC_APPLY);
            case ADMIN, OWNER -> Set.of(Capability.values());
        };
    }
}
