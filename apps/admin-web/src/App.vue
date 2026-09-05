<script setup lang="ts">
/**
 * 组合根（M4-A 任务 2/3）：a-config-provider（antd 内置文案随 i18n 语言联动，desktop 同款
 * 联动先例——表格空态/分页等组件内建文案不落英文死角）+ 路由出口；store 实例由 main.ts
 * 装配后经路由 props 下传视图。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ConfigProvider as AConfigProvider } from "ant-design-vue";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import enUS from "ant-design-vue/es/locale/en_US";

const { locale } = useI18n();
const antdLocale = computed(() => (locale.value === "zh-CN" ? zhCN : enUS));
</script>

<template>
  <a-config-provider :locale="antdLocale">
    <router-view />
  </a-config-provider>
</template>
