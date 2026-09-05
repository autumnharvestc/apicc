import { createApp } from "vue";
import App from "./App.vue";
import { createAdminI18n } from "./i18n/index.js";
import { createAdminClient } from "./api/client.js";
import { createSessionStore } from "./stores/session.js";
import { createWorkspacesStore } from "./stores/workspaces.js";
import { createAppRouter } from "./router/index.js";

// 组合根装配（M4-A 任务 2/3）：client → session/workspaces store（共享 client；401 钩子经
// setOnUnauthorized 回接 session store）→ router（守卫读会话）。启动先跑验活的同步前缀
// （读档落 token，守卫首航即见确定会话态），验活异步收口（失败清档回登录页）。
// 会话失效跳转带 redirect（任务 2 审查次要顺修）：当前非登录页时记录原 fullPath 供重登回跳。
// 组件内零工厂调用：store 实例经路由 props 下传视图（desktop App.vue 装配先例）。
const { i18n } = createAdminI18n();
const client = createAdminClient();
const session = createSessionStore({
  client,
  onSessionExpired: () => {
    const current = router.currentRoute.value;
    if (current.name !== "login") {
      void router.push({ name: "login", query: { redirect: current.fullPath } });
    }
  },
});
const workspaces = createWorkspacesStore({ client });
const router = createAppRouter({ session, workspaces });
void session.initialize();
createApp(App).use(i18n).use(router).mount("#app");
