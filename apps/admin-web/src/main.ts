import { createApp } from "vue";
import App from "./App.vue";
import { createAdminI18n } from "./i18n/index.js";
import { createAdminClient } from "./api/client.js";
import { createSessionStore } from "./stores/session.js";
import { createWorkspacesStore } from "./stores/workspaces.js";
import { createUsersStore } from "./stores/users.js";
import { createAppRouter } from "./router/index.js";

const { i18n } = createAdminI18n();
// 文档标题/语言随 i18n 初始语言（终审顺手⑥：index.html 静态默认值保留，启动即按语言覆盖）
document.title = i18n.global.t("app.title");
document.documentElement.lang = i18n.global.locale.value;

const client = createAdminClient();
const workspaces = createWorkspacesStore({ client });
const users = createUsersStore({ client });
// 会话销毁重置各 store 上下文（终审 Important 2，任务 5 起 users 一并清）：登出与会话失效
// （401/验活失败）两路均清，防换账号后残留上一账号的选中工作区/成员/树/ACL/账号清单呈现错位。
const resetStoresContext = () => {
  workspaces.reset();
  users.reset();
};
const session = createSessionStore({
  client,
  onSessionExpired: () => {
    resetStoresContext();
    const current = router.currentRoute.value;
    if (current.name !== "login") {
      void router.push({ name: "login", query: { redirect: current.fullPath } });
    }
  },
  onSignedOut: resetStoresContext,
});
const router = createAppRouter({ session, workspaces, users });
// 启动先跑验活的同步前缀（读档落 token，守卫首航即见确定会话态），验活异步收口（失败清档回登录页）。
// 组件内零工厂调用：store 实例经路由 props 下传视图（desktop App.vue 装配先例）。
void session.initialize();
createApp(App).use(i18n).use(router).mount("#app");
