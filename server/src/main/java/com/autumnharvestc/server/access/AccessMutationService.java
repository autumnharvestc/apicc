package com.autumnharvestc.server.access;

import com.autumnharvestc.server.core.*;
import com.autumnharvestc.server.store.*;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** All access writes, irreversible invalidation and safe audit share one transaction. */
@Service
public class AccessMutationService {
    private final AclRepo acl;
    private final MembershipRepo memberships;
    private final UserRepo users;
    private final TokenRepo tokens;
    private final WorkspaceRepo workspaces;
    private final ProjectRepo projects;
    private final ProjectAccessService access;
    private final PermissionService permissions;
    private final AccessRepo records;
    private final TransactionTemplate transactions;
    private final com.autumnharvestc.server.collaboration.policy.CollaborationPolicyRepo collaborationPolicyLocks;
    private final org.springframework.beans.factory.ObjectProvider<com.autumnharvestc.server.collaboration.grants.GrantService> grants;

    public AccessMutationService(AclRepo acl,MembershipRepo memberships,UserRepo users,TokenRepo tokens,
                                  WorkspaceRepo workspaces,ProjectRepo projects,ProjectAccessService access,
                                  PermissionService permissions,AccessRepo records,PlatformTransactionManager manager,
                                  com.autumnharvestc.server.collaboration.policy.CollaborationPolicyRepo collaborationPolicyLocks,
                                  org.springframework.beans.factory.ObjectProvider<com.autumnharvestc.server.collaboration.grants.GrantService> grants) {
        this.acl=acl;this.memberships=memberships;this.users=users;this.tokens=tokens;this.workspaces=workspaces;
        this.projects=projects;this.access=access;this.permissions=permissions;this.records=records;
        transactions=new TransactionTemplate(manager);
        this.collaborationPolicyLocks=collaborationPolicyLocks;this.grants=grants;
    }
    private enum Authority { WORKSPACE_ADMIN, PROJECT_ADMIN, SUPERADMIN }

    private void actor(UserAccount presented,Long ws,Long project,Authority authority) {
        UserAccount current=users.lockById(presented.id()).orElseThrow(AccessMutationService::forbidden);
        if(current.disabled())throw forbidden();
        if(authority==Authority.SUPERADMIN){
            if(current.role()!=PlatformRole.SUPERADMIN)throw new ApiException(HttpStatus.FORBIDDEN,"superadmin_required","需要平台超级管理员权限");
            return;
        }
        if(workspaces.findById(ws).isEmpty())throw new ApiException(HttpStatus.NOT_FOUND,"workspace_not_found","工作区不存在");
        Role workspaceRole=memberships.findRole(ws,current.id()).orElseThrow(AccessMutationService::forbidden);
        boolean allowed=permissions.isAdmin(workspaceRole);
        if(!allowed&&authority==Authority.PROJECT_ADMIN)
            allowed=access.resolve(current.id(),ws,project).effectiveRole().map(permissions::isAdmin).orElse(false);
        if(!allowed)throw forbidden();
    }
    private void scope(Long ws,Long project) {
        if(workspaces.findById(ws).isEmpty())throw new ApiException(HttpStatus.NOT_FOUND,"workspace_not_found","工作区不存在");
        if(project!=null&&projects.find(project).filter(p->p.workspaceId().equals(ws)).isEmpty())
            throw new ApiException(HttpStatus.NOT_FOUND,"project_not_found","项目不存在");
    }
    private Map<AccessRepo.SubjectProject,Integer> before(Long ws,Long project,Long userId) {
        var result=new LinkedHashMap<AccessRepo.SubjectProject,Integer>();
        for(var subject:records.affected(ws,project,userId))result.put(subject,qualification(subject));
        return result;
    }
    private int qualification(AccessRepo.SubjectProject subject) {
        var view=access.resolve(subject.userId(),subject.workspaceId(),subject.projectId());
        int mask=view.effectiveRole().isPresent()?1:0;
        if(view.capabilities().contains(Capability.HISTORY_READ))mask|=2;
        if(view.capabilities().contains(Capability.PUBLICATION_MANAGE))mask|=4;
        if(view.capabilities().contains(Capability.MOCK_MANAGE))mask|=8;
        return mask;
    }
    private void finish(UserAccount caller,Map<AccessRepo.SubjectProject,Integer> before,Long ws,Long project,Long userId,boolean forceInvalidation) {
        var affected=new LinkedHashSet<>(before.keySet());affected.addAll(records.affected(ws,project,userId));
        var generations=new LinkedHashSet<List<Long>>();
        var lost=new ArrayList<AccessRepo.SubjectProject>();
        for(var subject:affected){
            int old=before.getOrDefault(subject,0),now=qualification(subject);
            if(forceInvalidation||(old&~now)!=0){records.advanceResponsibilityEpoch(subject.workspaceId(),subject.projectId(),subject.userId());lost.add(subject);}
            generations.add(List.of(subject.workspaceId(),subject.projectId()));
        }
        for(var generation:generations)records.advanceProjectRevision(generation.get(0),generation.get(1));
        grants.getObject().responsibilityLost(caller.id(),lost);
    }
    private void transaction(Runnable body) {
        try{transactions.executeWithoutResult(tx->{collaborationPolicyLocks.lockGate();records.lockGate();body.run();});}
        catch(DuplicateKeyException ex){throw conflict();}
    }
    private void prepare(UserAccount caller,Long ws,Long project,Long userId,boolean policy,Authority authority) {
        records.lockScope(ws,project,userId,policy);
        records.lockActorMembership(ws,caller.id());
        if(userId!=null)users.lockById(userId);
        actor(caller,ws,project,authority);
        scope(ws,project);
        if(userId!=null&&users.findById(userId).isEmpty())throw new ApiException(HttpStatus.NOT_FOUND,"user_not_found","目标用户不存在");
    }
    private void writeMemberRole(UserAccount caller,Long ws,Long userId,Role role,long expected,JsonNode expectedActor) {
        Role current=memberships.findRole(ws,userId).orElse(null);
        if(current==Role.OWNER)throw new ApiException(HttpStatus.FORBIDDEN,"owner_immutable","不能变更 OWNER 的角色");
        if(role==Role.OWNER){
            if(memberships.findRole(ws,caller.id()).orElse(null)!=Role.OWNER)
                throw new ApiException(HttpStatus.FORBIDDEN,"requires_owner","提升为 OWNER 仅工作区 OWNER 可执行");
            long actorRevision=AccessRequests.actorRevision(expectedActor);
            if(records.changeMember(ws,userId,expected)==0)throw conflict();
            if(records.changeMember(ws,caller.id(),actorRevision)==0)throw conflict();
            if(current==null){acl.suspendPositiveOverrides(ws,userId);memberships.insert(ws,userId,Role.OWNER);}
            else memberships.updateRole(ws,userId,Role.OWNER);
            memberships.updateRole(ws,caller.id(),Role.ADMIN);
        }else{
            if(records.changeMember(ws,userId,expected)==0)throw conflict();
            if(current==null){acl.suspendPositiveOverrides(ws,userId);memberships.insert(ws,userId,role);}
            else memberships.updateRole(ws,userId,role);
        }
    }
    public void putMember(UserAccount caller,Long ws,Long userId,Role role,long expected,JsonNode expectedActor) {
        transaction(()->{
            prepare(caller,ws,null,userId,false,Authority.WORKSPACE_ADMIN);
            var before=before(ws,null,role==Role.OWNER?null:userId);
            writeMemberRole(caller,ws,userId,role,expected,expectedActor);
            finish(caller,before,ws,null,role==Role.OWNER?null:userId,false);
            records.audit(caller.id(),ws,null,userId,records.memberRevision(ws,userId),role==Role.OWNER?"workspace-owner-transferred":"member-role-updated");
        });
    }
    public void removeMember(UserAccount caller,Long ws,Long userId,long expected) {
        transaction(()->{
            prepare(caller,ws,null,userId,false,Authority.WORKSPACE_ADMIN);
            Role role=memberships.findRole(ws,userId).orElseThrow(()->new ApiException(HttpStatus.NOT_FOUND,"member_not_found","目标不是工作区成员"));
            if(role==Role.OWNER)throw new ApiException(HttpStatus.FORBIDDEN,"owner_immutable","不能移除 OWNER");
            var before=before(ws,null,userId);
            records.retainDeletedMember(ws,userId,expected);records.advanceMembershipEpoch(ws,userId);
            acl.suspendPositiveOverrides(ws,userId);memberships.delete(ws,userId);
            finish(caller,before,ws,null,userId,true);
            records.audit(caller.id(),ws,null,userId,records.memberRevision(ws,userId),"member-removed");
        });
    }
    public void putAcl(UserAccount caller,Long ws,Long project,Long userId,AclRole role,long expected) {
        transaction(()->{
            prepare(caller,ws,project,userId,false,Authority.WORKSPACE_ADMIN);var before=before(ws,project,userId);
            if(acl.compareAndSet(ws,project,userId,role,expected,caller.id(),records.membershipEpoch(ws,userId))==0)throw conflict();
            finish(caller,before,ws,project,userId,false);records.audit(caller.id(),ws,project,userId,acl.revision(ws,project,userId),"project-role-confirmed");
        });
    }
    public void deleteAcl(UserAccount caller,Long ws,Long project,Long userId,long expected) {
        transaction(()->{
            prepare(caller,ws,project,userId,false,Authority.WORKSPACE_ADMIN);var before=before(ws,project,userId);
            if(acl.compareAndDelete(ws,project,userId,expected)==0)throw conflict();
            finish(caller,before,ws,project,userId,false);records.audit(caller.id(),ws,project,userId,acl.revision(ws,project,userId),"project-inheritance-confirmed");
        });
    }
    public void updatePolicy(UserAccount caller,Long ws,Long project,AccessRequests.PolicyUpdate update) {
        transaction(()->{
            prepare(caller,ws,project,null,true,project==null?Authority.WORKSPACE_ADMIN:Authority.PROJECT_ADMIN);
            var before=before(ws,project,null);long scope=project==null?0:project;
            if(records.changePolicy(ws,scope,update.expectedRevision())==0)throw conflict();records.patchDefaults(ws,scope,update.defaults());
            finish(caller,before,ws,project,null,false);records.audit(caller.id(),ws,project,null,records.policyRevision(ws,scope),"capability-defaults-updated");
        });
    }
    public void updateAccessMember(UserAccount caller,Long ws,Long project,Long userId,AccessRequests.MemberUpdate update) {
        transaction(()->{
            boolean roleMutation=update.role()!=null||!update.action().equals("update");
            prepare(caller,ws,project,userId,false,project==null||roleMutation?Authority.WORKSPACE_ADMIN:Authority.PROJECT_ADMIN);
            if(!update.capabilities().isEmpty()&&(users.findById(userId).orElseThrow().disabled()||memberships.findRole(ws,userId).isEmpty()))
                throw new ApiException(HttpStatus.CONFLICT,"target_not_active_member","目标须是当前启用的成员");
            boolean transfer=project==null&&"OWNER".equals(update.role());
            var before=before(ws,project,transfer?null:userId);
            if(project==null){
                if(update.role()!=null)writeMemberRole(caller,ws,userId,Role.valueOf(update.role()),update.expectedRevision(),update.expectedActorRevision());
                else if(records.changeMember(ws,userId,update.expectedRevision())==0)throw conflict();
            }else{
                int changed=update.action().equals("confirm-inheritance")?acl.compareAndDelete(ws,project,userId,update.expectedRevision()):
                        update.role()!=null?acl.compareAndSet(ws,project,userId,AclRole.valueOf(update.role()),update.expectedRevision(),caller.id(),records.membershipEpoch(ws,userId)):
                        acl.changeCapabilities(ws,project,userId,update.expectedRevision());
                if(changed==0)throw conflict();
            }
            records.patchCapabilities(ws,project==null?0:project,userId,update.capabilities());
            finish(caller,before,ws,project,transfer?null:userId,false);
            records.audit(caller.id(),ws,project,userId,project==null?records.memberRevision(ws,userId):acl.revision(ws,project,userId),"member-access-updated");
        });
    }
    public void setAdminWorkspaceRole(UserAccount caller,Long ws,Long userId,Role role,long expected) {
        transaction(()->{
            prepare(caller,ws,null,userId,false,Authority.SUPERADMIN);
            if(memberships.findRole(ws,userId).orElse(null)==Role.OWNER)throw new ApiException(HttpStatus.FORBIDDEN,"owner_immutable","不能变更 OWNER 的角色");
            var before=before(ws,null,userId);
            if(records.changeMember(ws,userId,expected)==0)throw conflict();
            if(memberships.findRole(ws,userId).isPresent())memberships.updateRole(ws,userId,role);
            else{acl.suspendPositiveOverrides(ws,userId);memberships.insert(ws,userId,role);}
            finish(caller,before,ws,null,userId,false);records.audit(caller.id(),ws,null,userId,records.memberRevision(ws,userId),"admin-member-role-updated");
        });
    }
    public void setAccountState(UserAccount caller,Long userId,boolean disabled,long expected) {
        transaction(()->{
            UserAccount target=users.lockById(userId).orElse(null);
            for(var subject:records.affected(null,null,userId))records.lockScope(subject.workspaceId(),subject.projectId(),null,false);
            actor(caller,null,null,Authority.SUPERADMIN);
            var before=before(null,null,userId);
            if(target==null)throw new ApiException(HttpStatus.NOT_FOUND,"user_not_found","未找到账号");
            if(caller.id().equals(userId)&&disabled)throw new ApiException(HttpStatus.BAD_REQUEST,"cannot_disable_self","不能停用自己的账号");
            if(users.compareAndSetDisabled(userId,disabled,expected)==0)throw conflict();
            if(disabled)tokens.revokeAllByUser(userId);
            finish(caller,before,null,null,userId,!target.disabled()&&disabled);
            records.audit(caller.id(),null,null,userId,users.stateRevision(userId),disabled?"account-disabled":"account-enabled");
        });
    }
    public static ApiException conflict(){return new ApiException(HttpStatus.CONFLICT,"access_revision_conflict","授权修订已变化，请刷新后重试");}
    private static ApiException forbidden(){return new ApiException(HttpStatus.FORBIDDEN,"forbidden","当前账号或权限不可用");}
}
