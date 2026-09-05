import { createApp } from "vue";
import App from "./App.vue";
import { createAdminI18n } from "./i18n/index.js";
import { createAdminClient } from "./api/client.js";
import { createSessionStore } from "./stores/session.js";
import { createAppRouter } from "./router/index.js";

// 组合根装配（M4-A 任务 2）：client → session store（401 钩子经 setOnUnauthorized 回接
// store，路由跳转经 onSessionExpired 注入）→ router（守卫读会话）。启动先跑验活的同步
// 前缀（读档落 token，守卫首航即见确定会话态），验活异步收口（失败清档回登录页）。
// 组件内零工厂调用：store 实例经路由 props 下传视图（desktop App.vue 装配先例）。
const { i18n } = createAdminI18n();
const client = createAdminClient();
const session = createSessionStore({
  client,
  onSessionExpired: () => void router.push({ name: "login" }),
});
const router = createAppRouter({ session });
void session.initialize();
createApp(App).use(i18n).use(router).mount("#app");
