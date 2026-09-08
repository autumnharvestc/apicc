package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.content.WorkspaceContentStore;
import com.autumnharvestc.server.store.GroupRecord;
import com.autumnharvestc.server.store.GroupRepo;
import com.autumnharvestc.server.store.WorkspaceRecord;
import com.autumnharvestc.server.store.WorkspaceRepo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.UUID;

/**
 * 默认工作区启动种子（规格 2026-09-08 §1/§4）：服务端首次启动自动创建唯一「默认工作区」
 * （名称固定「默认工作区」）并联动建「默认分组」（is_default=TRUE）。
 * 幂等纪律与 {@link com.autumnharvestc.server.auth.AdminBootstrap} 同款：workspaces 表非空一律 no-op
 * （重启不重建、不重打日志）；并发双实例同时判空时由 uk_workspaces_name 唯一约束兜底，
 * 落败方收 DuplicateKeyException 视为「已被对端建好」静默忽略（冲突忽略）。
 * created_by 存空串：系统种子无创建者（列 NOT NULL 但无外键；规格 §1 工作区退化为内部实现，
 * 创建者语义只属于用户经 API 建区的路径）。
 * 内容目录按 §2 D6「建区建目录」同款建立，保持树读取对目录存在性的既有假设（任务 3 入库后随磁盘树退役）。
 */
@Component
public class DefaultWorkspaceSeeder implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DefaultWorkspaceSeeder.class);

    /** 规格 2026-09-08 §1：默认工作区名称固定。 */
    public static final String DEFAULT_WORKSPACE_NAME = "默认工作区";

    private final WorkspaceRepo workspaces;
    private final GroupRepo groups;
    private final WorkspaceContentStore contentStore;

    public DefaultWorkspaceSeeder(WorkspaceRepo workspaces,
                                  GroupRepo groups,
                                  WorkspaceContentStore contentStore) {
        this.workspaces = workspaces;
        this.groups = groups;
        this.contentStore = contentStore;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (workspaces.count() > 0) {
            return;
        }
        WorkspaceRecord workspace = new WorkspaceRecord(
                UUID.randomUUID().toString(), DEFAULT_WORKSPACE_NAME, "", Instant.now());
        contentStore.createWorkspaceDir(workspace.id());
        try {
            workspaces.insert(workspace);
        } catch (DuplicateKeyException ex) {
            // 并发兜底：另一实例已建默认工作区（uk_workspaces_name）——清掉本实例刚建的目录，视为已就位
            contentStore.deleteWorkspaceDirRecursively(workspace.id());
            return;
        }
        groups.insert(new GroupRecord(
                UUID.randomUUID().toString(), workspace.id(),
                WorkspaceService.DEFAULT_GROUP_NAME, true, Instant.now()));
        log.info("首次启动：已创建默认工作区「{}」与默认分组「{}」",
                DEFAULT_WORKSPACE_NAME, WorkspaceService.DEFAULT_GROUP_NAME);
    }
}
