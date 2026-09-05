import { createApp } from "vue";
import App from "./App.vue";
import { createAdminI18n } from "./i18n/index.js";

// 组合根（M4-A 任务 1 最小形态）：i18n 装配 + 挂载；pinia/router 随任务 2 的
// 会话 store 与路由守卫接入（TDD 先行，此处不预接无消费者的装配）。
const { i18n } = createAdminI18n();
createApp(App).use(i18n).mount("#app");
