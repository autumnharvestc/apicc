/**
 * 应用路由（M4-A 任务 2，裁定 C）：createAppRouter 工厂接收 session store 实例；
 * 守卫——受保护路由（meta.requiresAuth）无 token 重定向 /login 并携带 redirect=原 fullPath
 * （登录成功后回跳原目标）；/login 可直达。路由经静态 props 向视图注入 store 实例
 * （组件内零工厂调用，沿 desktop 装配先例）。路由清单随任务 3+ 扩展（布局壳/工作区/成员/ACL）。
 */
import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from "vue-router";
import type { SessionStore } from "../stores/session.js";
import LoginView from "../views/LoginView.vue";
import HomeView from "../views/HomeView.vue";

declare module "vue-router" {
  interface RouteMeta {
    /** 受保护路由：未登录（无 token）重定向 /login。 */
    requiresAuth?: boolean;
  }
}

export function createAppRoutes(deps: { session: SessionStore }): RouteRecordRaw[] {
  return [
    { path: "/login", name: "login", component: LoginView, props: { session: deps.session } },
    { path: "/", name: "home", component: HomeView, props: { session: deps.session }, meta: { requiresAuth: true } },
  ];
}

export function createAppRouter(deps: { session: SessionStore }): Router {
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
