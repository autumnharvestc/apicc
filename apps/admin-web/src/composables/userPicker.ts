/**
 * 用户选择器（规格 2026-09-09 成员搜索）：内部 id 不许手输（先例级教训）——成员管理/项目 ACL
 * 两处添加行共用。选项 = 工作区现有成员（store.members，进页已载）+ 非成员候选（searchCandidates
 * 远程搜索，debounce 300ms）按 username 去重合并；users.username 全局唯一（uk_users_username）
 * 作选项 value 与解析键，提交时解析为 id——id 全程不进输入框。
 */
import { computed, onBeforeUnmount, ref, type Ref } from "vue";
import type { WorkspacesStore } from "../stores/workspaces.js";

/** 搜索 debounce（规格口径 ~300ms；导出供测试对照）。 */
export const SEARCH_DEBOUNCE_MS = 300;

export interface UserPickerOption {
  value: string;
  label: string;
}

export interface UserPicker {
  /** 选中/输入的用户名（选项 value；v-model 到 a-auto-complete）。 */
  username: Ref<string>;
  /** 成员在前、候选在后的合并选项。 */
  options: Ref<UserPickerOption[]>;
  /** a-auto-complete @search 透传（内置 debounce；空关键字即清）。 */
  onSearch: (keyword: string) => void;
  /** 解析当前用户名为 id；未命中（手输任意文本）返回 null。成员取 userId、候选取 id。 */
  resolveId: () => string | null;
  /** 复位输入与在途 debounce（添加成功/切上下文）。 */
  reset: () => void;
}

export function createUserPicker(workspaces: WorkspacesStore, workspaceId: Ref<string>): UserPicker {
  const username = ref("");
  let timer: ReturnType<typeof setTimeout> | null = null;

  const optionLabel = (u: { username: string; displayName: string }): string => `${u.username}（${u.displayName}）`;

  const options = computed<UserPickerOption[]>(() => {
    const byName = new Map<string, UserPickerOption>();
    for (const m of workspaces.members) {
      byName.set(m.username, { value: m.username, label: optionLabel(m) });
    }
    for (const c of workspaces.candidates) {
      if (!byName.has(c.username)) byName.set(c.username, { value: c.username, label: optionLabel(c) });
    }
    return [...byName.values()];
  });

  function onSearch(keyword: string): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void workspaces.searchCandidates(workspaceId.value, keyword);
    }, SEARCH_DEBOUNCE_MS);
  }

  function resolveId(): string | null {
    const name = username.value.trim();
    if (!name) return null;
    const member = workspaces.members.find((m) => m.username === name);
    if (member) return member.userId;
    const candidate = workspaces.candidates.find((c) => c.username === name);
    return candidate ? candidate.id : null;
  }

  function reset(): void {
    username.value = "";
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  onBeforeUnmount(() => {
    if (timer !== null) clearTimeout(timer);
  });

  return { username, options, onSearch, resolveId, reset };
}
