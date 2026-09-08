/**
 * 应用路由（M4-A 任务 2/3，任务 5/6 增补）：createAppRouter 工厂接收 session/workspaces/users/org
 * store 实例；守卫——受保护路由（meta.requiresAuth 声明于布局壳父路由，子路由随 vue-router meta
 * 合并继承）无 token 重定向 /login 并携带 redirect=原 fullPath（登录成功后回跳原目标）；/login
 * 可直达；超管专属路由（meta.requiresSuperadmin，/users）非 SUPERADMIN 重定向工作区列表——
 * 判据为 session.role（/me/login 写入），不写死；守卫先 await 首航验活 promise（deps.sessionReady）
 * 再评估，防 /me 落地前 role 仍为默认 USER 把超管深链误弹回（任务 5 审查重要 1）。布局壳 "/"
 * 下挂子路由（工作区列表/成员/项目 ACL/组织管理/用户管理，index 重定向到列表）。路由经静态 props
 * 向视图注入 store 实例（组件内零工厂调用，沿 desktop 装配先例）。
 */
import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from "vue-router";
import type { SessionStore } from "../stores/session.js";
import type { WorkspacesStore } from "../stores/workspaces.js";
import type { UsersStore } from "../stores/users.js";
import type { OrgStore } from "../stores/org.js";
import LoginView from "../views/LoginView.vue";
import LayoutView from "../views/LayoutView.vue";
import WorkspacesView from "../views/WorkspacesView.vue";
import MembersView from "../views/MembersView.vue";
import ProjectAclView from "../views/ProjectAclView.vue";
import UsersView from "../views/UsersView.vue";
import OrgView from "../views/OrgView.vue";

export interface AppRouterDeps {
  session: SessionStore;
  workspaces: WorkspacesStore;
  users: UsersStore;
  /** 组织管理（任务 6）：分组/项目清单成员可读、写动作 ADMIN+ 由服务端裁决。 */
  org: OrgStore;
  /**
   * 首航验活 promise（生产 = main.ts 的 session.initialize() 返回值，任务 5 审查重要 1）：
   * 守卫 await 其收口后再读 session.role——否则 /me 未落地时 role 仍为默认 USER，超管
   * F5/深链 /users 会被误弹回工作区列表且落地后无重新评估。省略 = 装配方保证首航前会话
   * 已确定（测试先 await initialize 的时序，await undefined 立即通过）。
   */
  sessionReady?: Promise<void>;
}

export function createAppRoutes(deps: AppRouterDeps): RouteRecordRaw[] {
  return [
    { path: "/login", name: "login", component: LoginView, props: { session: deps.session } },
    {
      // 父路由不具名（任务 3 审查次要 3 顺修）：无名父路由 + 空 path 子路由组合无 vue-router
      // 命名告警；子路由经具名（workspaces/workspace-members/workspace-acl）导航。
      path: "/",
      component: LayoutView,
      props: { session: deps.session, workspaces: deps.workspaces },
      meta: { requiresAuth: true },
      children: [
        { path: "", redirect: { name: "workspaces" } },
        { path: "workspaces", name: "workspaces", component: WorkspacesView, props: { workspaces: deps.workspaces } },
        // 成员/项目 ACL（任务 4/5 渐次填充）：真实视图均注入 workspaces 实例
        { path: "workspaces/:id/members", name: "workspace-members", component: MembersView, props: { workspaces: deps.workspaces } },
        { path: "workspaces/:id/acl", name: "workspace-acl", component: ProjectAclView, props: { workspaces: deps.workspaces } },
        // 组织管理（任务 6）：分组/项目 CRUD；页面成员可读，操作按钮按 myRole ADMIN+ 显隐
        { path: "workspaces/:id/org", name: "workspace-org", component: OrgView, props: { workspaces: deps.workspaces, org: deps.org } },
        // 用户管理（任务 5，超管专属）：注入 users 实例；守卫按 session.role 校验
        { path: "users", name: "users", component: UsersView, props: { users: deps.users }, meta: { requiresSuperadmin: true } },
      ],
    },
  ];
}

export function createAppRouter(deps: AppRouterDeps): Router {
  const router = createRouter({
    history: createWebHistory(),
    routes: createAppRoutes(deps),
  });
  router.beforeEach(async (to) => {
    // 先等首航验活收口（任务 5 审查重要 1）：role 由 /me 写入，未落地前评估 requiresSuperadmin
    // 会以默认 USER 误判。initialize 自吞错误恒 resolve（失败已清档/跳转），此处无需 try。
    await deps.sessionReady;
    if (to.meta.requiresAuth === true && !deps.session.token) {
      return { name: "login", query: { redirect: to.fullPath } };
    }
    // 超管专属路由（任务 5）：判据 session.role（/me/login 写入），非超管重定向工作区列表
    if (to.meta.requiresSuperadmin === true && deps.session.role !== "SUPERADMIN") {
      return { name: "workspaces" };
    }
    return true;
  });
  return router;
}
