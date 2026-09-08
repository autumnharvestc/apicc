package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 组织管理端点（规格 2026-09-08 §4/§6，计划 B 任务 2）：
 * 分组 GET/POST /api/v1/workspaces/{id}/groups、POST .../groups/{gid}/rename、DELETE .../groups/{gid}；
 * 项目 GET/POST .../projects、POST .../projects/{pid}/rename、POST .../projects/{pid}/move、DELETE .../projects/{pid}；
 * 握手 GET /api/v1/connect。
 * 401 由 AuthFilter 先行；403/404/409/400 语义码见 GroupService/ProjectService（守卫在 Service 首行）。
 */
@RestController
public class OrgController {

    private final GroupService groups;
    private final ProjectService projects;

    public OrgController(GroupService groups, ProjectService projects) {
        this.groups = groups;
        this.projects = projects;
    }

    /** 200 [{id, name, isDefault, createdAt}]（成员可读）；403 非成员。 */
    @GetMapping("/api/v1/workspaces/{id}/groups")
    public List<GroupService.GroupView> listGroups(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                                   @PathVariable String id) {
        return groups.list(caller, id);
    }

    /** 201 {id, name, isDefault, createdAt}；403 forbidden；409 group_name_taken；400 校验/默认分组守卫见 rename。 */
    @PostMapping("/api/v1/workspaces/{id}/groups")
    public ResponseEntity<GroupService.GroupView> createGroup(
            @RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
            @PathVariable String id,
            @Valid @RequestBody OrgRequests.CreateGroupRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(groups.create(caller, id, request));
    }

    /** 200 改名后视图；400 default_group_immutable；403 forbidden；404 group_not_found；409 group_name_taken。 */
    @PostMapping("/api/v1/workspaces/{id}/groups/{gid}/rename")
    public GroupService.GroupView renameGroup(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                              @PathVariable String id,
                                              @PathVariable String gid,
                                              @Valid @RequestBody OrgRequests.RenameGroupRequest request) {
        return groups.rename(caller, id, gid, request);
    }

    /** 204 删除；400 default_group_immutable；403 forbidden；404 group_not_found；409 group_not_empty。 */
    @DeleteMapping("/api/v1/workspaces/{id}/groups/{gid}")
    public ResponseEntity<Void> deleteGroup(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                            @PathVariable String id,
                                            @PathVariable String gid) {
        groups.delete(caller, id, gid);
        return ResponseEntity.noContent().build();
    }

    /** 200 [{id, groupId, name, createdAt}]（成员可读）。 */
    @GetMapping("/api/v1/workspaces/{id}/projects")
    public List<ProjectService.ProjectView> listProjects(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                                         @PathVariable String id) {
        return projects.list(caller, id);
    }

    /** 201 {id, groupId, name, createdAt}；403 forbidden；404 group_not_found；400 校验。 */
    @PostMapping("/api/v1/workspaces/{id}/projects")
    public ResponseEntity<ProjectService.ProjectView> createProject(
            @RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
            @PathVariable String id,
            @Valid @RequestBody OrgRequests.CreateProjectRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(projects.create(caller, id, request));
    }

    /** 200 改名后视图（同名允许）；403 forbidden；404 project_not_found。 */
    @PostMapping("/api/v1/workspaces/{id}/projects/{pid}/rename")
    public ProjectService.ProjectView renameProject(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                                    @PathVariable String id,
                                                    @PathVariable String pid,
                                                    @Valid @RequestBody OrgRequests.RenameProjectRequest request) {
        return projects.rename(caller, id, pid, request);
    }

    /** 204 移动；403 forbidden；404 project_not_found/group_not_found。 */
    @PostMapping("/api/v1/workspaces/{id}/projects/{pid}/move")
    public ResponseEntity<Void> moveProject(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                            @PathVariable String id,
                                            @PathVariable String pid,
                                            @Valid @RequestBody OrgRequests.MoveProjectRequest request) {
        projects.move(caller, id, pid, request);
        return ResponseEntity.noContent().build();
    }

    /** 204 删除（级联内容版本行与 ACL 行）；403 forbidden；404 project_not_found。 */
    @DeleteMapping("/api/v1/workspaces/{id}/projects/{pid}")
    public ResponseEntity<Void> deleteProject(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,
                                              @PathVariable String id,
                                              @PathVariable String pid) {
        projects.delete(caller, id, pid);
        return ResponseEntity.noContent().build();
    }

    /** 200 {workspaceId, workspaceName, myRole}；404 workspace_not_found（空库）；403 非成员。 */
    @GetMapping("/api/v1/connect")
    public ConnectView connect(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller) {
        return projects.connect(caller);
    }
}
