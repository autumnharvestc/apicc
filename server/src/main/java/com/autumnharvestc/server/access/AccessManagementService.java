package com.autumnharvestc.server.access;

import com.autumnharvestc.server.core.*;
import com.autumnharvestc.server.store.*;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class AccessManagementService {
    private final AccessRepo records;
    private final AclRepo acl;
    private final MembershipRepo memberships;
    private final UserRepo users;
    private final ProjectRepo projects;
    private final WorkspaceGuard guard;
    private final PermissionService permissions;
    private final ProjectAccessService access;
    private final AccessMutationService mutations;

    public AccessManagementService(AccessRepo records, AclRepo acl, MembershipRepo memberships, UserRepo users,
                                    ProjectRepo projects, WorkspaceGuard guard, PermissionService permissions,
                                    ProjectAccessService access, AccessMutationService mutations) {
        this.records=records; this.acl=acl; this.memberships=memberships; this.users=users; this.projects=projects;
        this.guard=guard; this.permissions=permissions; this.access=access; this.mutations=mutations;
    }

    private void requireManage(UserAccount caller, Long ws, Long project) {
        if (project == null) { guard.requireAdmin(ws, caller); return; }
        var membership = guard.requireMember(ws, caller);
        if (!permissions.isAdmin(membership.role()) && !access.resolve(caller.id(), ws, project).effectiveRole().map(permissions::isAdmin).orElse(false))
            throw new ApiException(HttpStatus.FORBIDDEN,"forbidden","需要项目管理权限");
        requireProject(ws, project);
    }

    private void requireProject(Long ws, Long project) {
        projects.find(project).filter(p -> p.workspaceId().equals(ws))
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,"project_not_found","项目不存在"));
    }

    /** Shared scope-management authority; collaboration policy does not create a second IAM decision. */
    public void requirePolicyManagement(UserAccount caller,Long ws,Long project) {
        if(users.findById(caller.id()).filter(current->!current.disabled()).isEmpty())
            throw new ApiException(HttpStatus.FORBIDDEN,"forbidden","当前账号不可用");
        requireManage(caller,ws,project);
    }

    public List<Map<String,Object>> directory(UserAccount caller, Long ws) {
        guard.requireAdmin(ws, caller);
        return projects.listByWorkspace(ws).stream().map(p -> Map.<String,Object>of("id",String.valueOf(p.id()),
                "name",p.name(),"contentReadable",access.resolve(caller.id(),ws,p.id()).effectiveRole().isPresent())).toList();
    }

    public Map<String,Object> policy(UserAccount caller, Long ws, Long project) {
        requireManage(caller,ws,project);
        long scope = project == null ? 0 : project;
        return Map.of("revision",records.policyRevision(ws,scope),"defaults",records.defaults(ws,scope),
                "capabilities",access.capabilityRows(caller.id(),ws,project));
    }

    public Map<String,Object> putPolicy(UserAccount caller, Long ws, Long project, JsonNode body) {
        requireManage(caller,ws,project);
        var update = AccessRequests.policy(body);
        mutations.updatePolicy(caller,ws,project,update);
        return policy(caller,ws,project);
    }

    public Map<String,Object> member(UserAccount caller, Long ws, Long project, String user) {
        requireManage(caller,ws,project);
        Long userId=EntityIds.parse(user);
        UserAccount account = users.findById(userId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,"user_not_found","目标用户不存在"));
        var decision = access.resolve(userId,ws,project);
        var view = new LinkedHashMap<String,Object>();
        view.put("userId",String.valueOf(userId)); view.put("member",decision.member()); view.put("accountEnabled",!account.disabled());
        view.put("workspaceRole",decision.workspaceRole().map(Enum::name).orElse(null));
        view.put("projectOverride",decision.projectOverride().map(Enum::name).orElse(null)); view.put("overrideState",decision.overrideState());
        view.put("effectiveRole",decision.effectiveRole().map(Enum::name).orElse(null));
        view.put("revision",project == null ? records.memberRevision(ws,userId) : acl.revision(ws,project,userId));
        view.put("membershipEpoch",decision.membershipEpoch()); view.put("responsibilityEpoch",decision.responsibilityEpoch());
        view.put("capabilities",access.capabilityRows(userId,ws,project));
        return view;
    }

    public Map<String,Object> putMember(UserAccount caller, Long ws, Long project, String user, JsonNode body) {
        requireManage(caller,ws,project);
        var update = AccessRequests.managedMember(body,project != null);
        if (update.role() != null || !update.action().equals("update")) guard.requireAdmin(ws,caller);
        Long userId=EntityIds.parse(user);
        UserAccount target = users.findById(userId).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,"user_not_found","目标用户不存在"));
        if (!update.capabilities().isEmpty() && (target.disabled() || memberships.findRole(ws,userId).isEmpty()))
            throw new ApiException(HttpStatus.CONFLICT,"target_not_active_member","目标须是当前启用的成员");
        if (project == null && update.role() != null && memberships.findRole(ws,userId).filter(r -> r == Role.OWNER).isPresent())
            throw new ApiException(HttpStatus.FORBIDDEN,"owner_immutable","不能变更 OWNER 的角色");
        mutations.updateAccessMember(caller,ws,project,userId,update);
        return member(caller,ws,project,user);
    }
}
