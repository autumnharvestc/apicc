package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.GroupRecord;
import com.autumnharvestc.server.store.GroupRepo;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.PlatformRole;
import com.autumnharvestc.server.store.UserRepo;
import com.autumnharvestc.server.store.WorkspaceRecord;
import com.autumnharvestc.server.store.WorkspaceRepo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;

import java.time.Instant;

/**
 * 默认工作区启动种子（规格 2026-09-08 §1/§4）：服务端首次启动自动创建唯一「默认工作区」
 * （名称固定「默认工作区」）并联动建「默认分组」（is_default=TRUE），随后给首个超管
 * （users 中 role=SUPERADMIN 按创建序第一个）插 OWNER memberships 行——默认工作区由系统建立
 * 无「建区者」，握手 myRole 语义需要区内角色锚点（裁定②）：不插行则超管 connect 得 403。
 * 幂等纪律与 {@link com.autumnharvestc.server.auth.AdminBootstrap} 同款：workspaces 表非空一律 no-op
 * （重启不重建、不重打日志）；OWNER 行已有成员关系即跳过；并发双实例同时判空时由
 * uk_workspaces_name 唯一约束兜底，落败方收 DuplicateKeyException 视为「已被对端建好」静默忽略。
 * @Order(2) 钉在 AdminBootstrap（@Order(1)）之后：OWNER 行插入依赖超管账号先建（启动时无超管
 * 理论不可达，出现则以 WARN 留痕并跳过——connect 对非成员 403 由守卫自然处理）。
 * created_by 存 0：系统种子无创建者（列 NOT NULL 但无外键；规格 §1 工作区退化为内部实现，
 * 创建者语义只属于用户经 API 建区的路径；BIGINT 化后以 0 作「无创建者」哨兵）。
 * 内容入库（规格 §5）后磁盘内容树退役：种子不再做任何目录操作。
 */
@Component
@Order(2)
public class DefaultWorkspaceSeeder implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DefaultWorkspaceSeeder.class);

    /** 规格 2026-09-08 §1：默认工作区名称固定。 */
    public static final String DEFAULT_WORKSPACE_NAME = "默认工作区";

    /** created_by 的「系统种子无创建者」哨兵（列 NOT NULL 但无外键，规格 §1）。 */
    private static final long NO_CREATOR = 0L;

    private final WorkspaceRepo workspaces;
    private final GroupRepo groups;
    private final MembershipRepo memberships;
    private final UserRepo users;

    public DefaultWorkspaceSeeder(WorkspaceRepo workspaces,
                                  GroupRepo groups,
                                  MembershipRepo memberships,
                                  UserRepo users) {
        this.workspaces = workspaces;
        this.groups = groups;
        this.memberships = memberships;
        this.users = users;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (workspaces.count() > 0) {
            return;
        }
        // BIGINT 化（规格 2026-09-09）：id 由 IDENTITY 生成，insert 返回补全 id 的记录供联动行引用
        WorkspaceRecord workspace;
        try {
            workspace = workspaces.insert(new WorkspaceRecord(
                    null, DEFAULT_WORKSPACE_NAME, NO_CREATOR, Instant.now()));
        } catch (DuplicateKeyException ex) {
            // 并发兜底：另一实例已建默认工作区（uk_workspaces_name）——视为已就位
            return;
        }
        groups.insert(new GroupRecord(
                null, workspace.id(),
                WorkspaceService.DEFAULT_GROUP_NAME, true, Instant.now()));
        grantOwnerToFirstSuperadmin(workspace.id());
        log.info("首次启动：已创建默认工作区「{}」与默认分组「{}」",
                DEFAULT_WORKSPACE_NAME, WorkspaceService.DEFAULT_GROUP_NAME);
    }

    /** 裁定②：首个超管自动入区 OWNER（幂等：已有成员关系即跳过；无超管 WARN 跳过，见类注）。 */
    private void grantOwnerToFirstSuperadmin(long workspaceId) {
        users.findAll().stream()
                .filter(user -> user.role() == PlatformRole.SUPERADMIN)
                .findFirst()
                .ifPresentOrElse(admin -> {
                    if (memberships.findRole(workspaceId, admin.id()).isPresent()) {
                        return; // 幂等：存在即跳过
                    }
                    memberships.insert(workspaceId, admin.id(), Role.OWNER);
                    log.info("默认工作区：已将首个超管 {} 设为 OWNER", admin.username());
                }, () -> log.warn("默认工作区建立时未找到超管账号，跳过 OWNER 授予"
                        + "（理论不可达：AdminBootstrap 先于本器执行）"));
    }
}
