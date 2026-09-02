import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { initI18n } from "./i18n/bridge";
import "./styles/theme.css";

const { i18n } = initI18n();
createApp(App).use(createPinia()).use(i18n).mount("#app");
