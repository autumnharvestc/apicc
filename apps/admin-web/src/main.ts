import { createApp } from "vue";
import App from "./App.vue";
import { createAdminI18n } from "./i18n/index.js";
import { createAdminClient } from "./api/client.js";
import { createSessionStore } from "./stores/session.js";
import { createWorkspacesStore } from "./stores/workspaces.js";
import { createUsersStore } from "./stores/users.js";
import { createOrgStore } from "./stores/org.js";
import { createAppRouter } from "./router/index.js";

const { i18n } = createAdminI18n();
// 文档标题/语言随 i18n 初始语言（终审顺手⑥：index.html 静态默认值保留，启动即按语言覆盖）
document.title = i18n.global.t("app.title");
document.documentElement.lang = i18n.global.locale.value;

const client = createAdminClient();
const workspaces = createWorkspacesStore({ client });
const users = createUsersStore({ client });
const org = createOrgStore({ client });
// 会话销毁重置各 store 上下文（终审 Important 2，任务 5 起 users、任务 6 起 org 一并清）：
// 登出与会话失效（401/验活失败）两路均清，防换账号后残留上一账号的选中工作区/成员/树/ACL/
// 账号清单/组织清单呈现错位。
const resetStoresContext = () => {
  workspaces.reset();
  users.reset();
  org.reset();
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
// 首航验活（main.ts 时序，任务 5 审查重要 1 修复）：initialize 不等待即装配路由并 mount——
// 守卫 await 其返回的 promise（deps.sessionReady）收口后再评估 requiresSuperadmin，超管
// F5/深链 /users 不因 role 未落地被误弹回工作区；验活失败自清档并经 onSessionExpired 回登录页。
// onSessionExpired 闭包引用的 router 在同一同步块内随后赋值，回调只会微任务后触发，无 TDZ。
const router = createAppRouter({ session, workspaces, users, org, client, sessionReady: session.initialize() });
// 组件内零工厂调用：store 实例经路由 props 下传视图（desktop App.vue 装配先例）。
createApp(App).use(i18n).use(router).mount("#app");
