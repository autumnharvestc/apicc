/**
 * 应用路由（M4-A 任务 2/3，裁定 C）：createAppRouter 工厂接收 session/workspaces store 实例；
 * 守卫——受保护路由（meta.requiresAuth 声明于布局壳父路由，子路由随 vue-router meta 合并
 * 继承）无 token 重定向 /login 并携带 redirect=原 fullPath（登录成功后回跳原目标）；/login
 * 可直达。布局壳 "/" 下挂子路由（工作区列表/成员占位/项目 ACL 占位，index 重定向到列表）。
 * 路由经静态 props 向视图注入 store 实例（组件内零工厂调用，沿 desktop 装配先例）。
 */
import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from "vue-router";
import type { SessionStore } from "../stores/session.js";
import type { WorkspacesStore } from "../stores/workspaces.js";
import LoginView from "../views/LoginView.vue";
import LayoutView from "../views/LayoutView.vue";
import WorkspacesView from "../views/WorkspacesView.vue";
import MembersView from "../views/MembersView.vue";
import ProjectAclView from "../views/ProjectAclView.vue";

export interface AppRouterDeps {
  session: SessionStore;
  workspaces: WorkspacesStore;
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
        // 成员/项目 ACL（任务 4/5 渐次填充）：members 真实视图注入 workspaces 实例；acl 仍占位
        { path: "workspaces/:id/members", name: "workspace-members", component: MembersView, props: { workspaces: deps.workspaces } },
        { path: "workspaces/:id/acl", name: "workspace-acl", component: ProjectAclView },
      ],
    },
  ];
}

export function createAppRouter(deps: AppRouterDeps): Router {
  const router = createRouter({
    history: createWebHistory(),
    routes: createAppRoutes(deps),
  });
  router.beforeEach((to) => {
    if (to.meta.requiresAuth === true && !deps.session.token) {
      return { name: "login", query: { redirect: to.fullPath } };
    }
    return true;
  });
  return router;
}
