<script setup lang="ts">
/**
 * 布局壳（M4-A 任务 3，任务 5/6 增补）：a-layout 侧栏（a-menu——工作区项常显；组织管理入口仅
 * 当前选中工作区已拉取详情时可见（所有成员可读，页面内操作按钮再按 myRole ADMIN+ 显隐，任务 6）；
 * 成员/项目 ACL 管理入口仅 myRole ∈ {OWNER, ADMIN} 可见，按 workspaces.current 动态，详情未拉取
 * 时隐藏防闪烁，裁定 C；「用户管理」入口仅 session.role === SUPERADMIN 可见——role 由 /me/login
 * 写入会话 store，规格 2026-09-08 §6）+ 顶栏（当前用户 displayName + 登出）。子路由挂内容区。
 * 工作区上下文：路由参数驱动的选中（watch :id → workspaces.select）+ 列表行点选（不换页，
 * 选中后菜单按角色出现）。组件内零工厂调用：session/workspaces 经路由 props 注入。
 */
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { Button as AButton, Layout as ALayout, Menu as AMenu, MenuItem as AMenuItem } from "ant-design-vue";
import type { SessionStore } from "../stores/session.js";
import type { WorkspacesStore } from "../stores/workspaces.js";

const ALayoutSider = ALayout.Sider;
const ALayoutHeader = ALayout.Header;
const ALayoutContent = ALayout.Content;

const props = defineProps<{ session: SessionStore; workspaces: WorkspacesStore }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

/** 管理入口可见性：选中工作区详情已拉取且 myRole ∈ {OWNER, ADMIN}（裁定 A；D6 后端 403 为准）。 */
const manageVisible = computed(() => {
  const current = props.workspaces.current;
  return current !== null && (current.myRole === "OWNER" || current.myRole === "ADMIN");
});

// 路由参数驱动的选中：直达 /workspaces/:id/members|acl 时按 :id 拉详情（菜单显隐随之更新）。
watch(
  () => route.params.id,
  (id) => {
    if (typeof id === "string" && id !== "" && props.workspaces.current?.id !== id) {
      void props.workspaces.select(id);
    }
  },
  { immediate: true },
);

function goWorkspaces(): void {
  void router.push({ name: "workspaces" });
}

function goMembers(): void {
  const current = props.workspaces.current;
  if (current) void router.push(`/workspaces/${encodeURIComponent(current.id)}/members`);
}

function goAcl(): void {
  const current = props.workspaces.current;
  if (current) void router.push(`/workspaces/${encodeURIComponent(current.id)}/acl`);
}

/** 组织管理（任务 6）：所有成员可读（页面内操作按钮按 myRole ADMIN+ 显隐）。 */
function goOrg(): void {
  const current = props.workspaces.current;
  if (current) void router.push(`/workspaces/${encodeURIComponent(current.id)}/org`);
}

function goUsers(): void {
  void router.push({ name: "users" });
}

async function onLogout(): Promise<void> {
  await props.session.logout();
  await router.push({ name: "login" });
}
</script>

<template>
  <a-layout class="layout" data-testid="layout-view">
    <a-layout-sider theme="light" class="sider">
      <div class="brand" data-testid="layout-brand">{{ t("app.title") }}</div>
      <a-menu mode="inline" data-testid="layout-menu">
        <a-menu-item key="workspaces" data-testid="menu-workspaces" @click="goWorkspaces">
          {{ t("nav.workspaces") }}
        </a-menu-item>
        <a-menu-item v-if="manageVisible" key="members" data-testid="menu-members" @click="goMembers">
          {{ t("nav.members") }}
        </a-menu-item>
        <a-menu-item v-if="manageVisible" key="acl" data-testid="menu-acl" @click="goAcl">
          {{ t("nav.acl") }}
        </a-menu-item>
        <a-menu-item v-if="workspaces.current !== null" key="org" data-testid="menu-org" @click="goOrg">
          {{ t("nav.org") }}
        </a-menu-item>
        <a-menu-item v-if="session.role === 'SUPERADMIN'" key="users" data-testid="menu-users" @click="goUsers">
          {{ t("nav.users") }}
        </a-menu-item>
      </a-menu>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="header" data-testid="layout-header">
        <span class="user" data-testid="layout-user">{{ session.user?.displayName }}</span>
        <a-button data-testid="layout-logout" @click="onLogout">{{ t("nav.logout") }}</a-button>
      </a-layout-header>
      <a-layout-content class="content">
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<style scoped>
.layout {
  min-height: 100vh;
}
.sider {
  background: #fff;
}
.brand {
  padding: 16px;
  font-weight: 600;
  font-size: 15px;
}
.header {
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 0 24px;
}
.user {
  font-size: 13px;
}
.content {
  padding: 24px;
}
</style>
