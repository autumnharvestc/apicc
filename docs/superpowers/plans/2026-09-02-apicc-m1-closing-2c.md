# apicc M1 计划 2C：收口——调试完整性、TopBar 现代化与打包补全 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成 M1 收口三件事：① 调试视图补环境选择器与用例选择器（规格 §7.1/§7.3 调试流完整性）；② TopBar 语言/主题切换控件现代化（用户反馈，antd 风格统一）；③ 打包补全（应用元数据、自绘合规图标、asar 瘦身）。

**架构：** 调试选择状态入 debug store（跨视图切换存活，组合根单例）；RequestEditor 新增两个 a-select，send 链路带 `caseId`/`envName`（主进程 resolveEnv 与空结果守卫已存在，直接受益）。TopBar 用 a-dropdown（语言）+ a-segmented（主题），保留 data-testid 与联动语义。打包：renderer 运行时依赖（vue/pinia/vue-i18n/ant-design-vue）移 devDependencies（vite 已打进 dist-renderer，主进程不需要），`@apicc/core` 保持 dependencies（主进程运行时依赖）；自绘图标（几何图形程序化生成，无字体、无第三方素材，合规约束见项目记忆 asset-license-compliance）。

**技术栈：** 既有栈 + pngjs（devDep，图标生成脚本用，纯 JS MIT）。

**范围外（已归档后续阶段）：** 检查升级/自动升级（electron-updater + GitHub Releases，待远端仓库与发布流程就绪）；M2 工作流/压测。

---

## 文件结构（2C 变更）

```
apps/desktop/
  src/renderer/src/components/RequestEditor.vue   ← 调试环境/用例两个 a-select + send 链路
  src/renderer/src/stores/debug.ts                ← selectedEnvName/selectedCaseId 状态与回退
  src/renderer/src/components/ThemeLanguageToggle.vue ← a-dropdown + a-segmented 重写
  src/renderer/src/i18n/{zh-CN,en}.json           ← 新增 theme 三态/语言菜单/editor.noEnv 等键
  tests/renderer/stores/debug.test.ts             ← 选择/回退用例
  tests/renderer/components/components.test.ts    ← RequestEditor 选择器用例
  tests/renderer/components/antd-linkage.test.ts  ← 适配新交互
  tests/renderer/App.test.ts                      ← 语言切换路径适配
  scripts/gen-icon.mjs                            ← 自绘图标程序化生成（pngjs）
  build/icon.png                                  ← 生成产物（入库）
  package.json                                    ← 元数据（description/author）+ 依赖归位 + gen:icon 脚本
  electron-builder.yml                            ← 图标说明注释（build/icon.png 为默认约定）
```

---

### 任务 1：调试环境选择器与用例选择器

**文件：**
- 修改：`apps/desktop/src/renderer/src/stores/debug.ts`、`src/renderer/src/components/RequestEditor.vue`、`src/renderer/src/i18n/{zh-CN,en}.json`
- 测试：`apps/desktop/tests/renderer/stores/debug.test.ts`、`apps/desktop/tests/renderer/components/components.test.ts`

- [ ] **步骤 1：编写失败的 debug store 测试**（在现有 debug.test.ts 追加）

```ts
it("选择环境与用例后按选择发送；失效选择自动回退", async () => {
  const { editor, debug } = await seeded();
  await debug.send(editor); // 现状基线：cases[0]
  editor.api!.cases.push({ id: "t2", name: "second", scope: "base", parameters: {}, assertions: [] });
  debug.selectCase("t2");
  debug.selectEnv("dev");
  let captured: { apiId: string; caseId: string; envName?: string } | null = null;
  await debug.send(editor, (input) => { captured = input; return Promise.resolve({ run: { total: 1, passed: 1, failed: 0, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" }, outcome: { apiId: "a", apiName: "a", caseId: "t2", caseName: "t2", passed: true, durationMs: 1, assertions: [] } }); }, undefined);
  expect(captured).toMatchObject({ caseId: "t2", envName: "dev" });
  // 失效回退：选中的用例/环境不在当前接口/项目里时回退 cases[0]/无环境
  editor.api!.cases = editor.api!.cases.filter((c) => c.id === "t0");
  editor.envs = [];
  await debug.send(editor, (input) => { captured = input; return Promise.resolve({ run: { total: 1, passed: 1, failed: 0, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" }, outcome: { apiId: "a", apiName: "a", caseId: "t0", caseName: "t0", passed: true, durationMs: 1, assertions: [] } }); }, undefined);
  expect(captured).toMatchObject({ caseId: editor.api!.cases[0]!.id });
  expect(captured!.envName).toBeUndefined();
});
```

注意：现有 seeded() 的基座用例 id 以实际 memory 种子为准（实现者核对后对齐，测试内注释）。`send` 的第三个参数与选择状态的关系裁定：**显式传入的 envName 优先，其次 store 的 selectedEnvName**（RequestEditor 只传 undefined 走 store 状态；既有测试用显式参数注入的路径不受影响）。

- [ ] **步骤 2：运行验证失败 → 实现 debug store**

`stores/debug.ts` 增：

```ts
state 增: selectedEnvName: null as string | null, selectedCaseId: null as string | null,
actions 增:
  selectEnv(name: string | null) { this.selectedEnvName = name; },
  selectCase(id: string | null) { this.selectedCaseId = id; },
send() 内替换取值逻辑（显式参数 envName 仍优先）:
  const cases = editor.api?.cases ?? [];
  const caseId = this.selectedCaseId && cases.some((c) => c.id === this.selectedCaseId)
    ? this.selectedCaseId! : cases[0]?.id;
  const envName = explicitEnvName
    ?? (this.selectedEnvName && (editor.envs ?? []).some((e) => e.name === this.selectedEnvName)
      ? this.selectedEnvName : undefined);
  // caseId 为 undefined（无用例）维持既有静默 return
```

- [ ] **步骤 3：RequestEditor 增两个选择器**

URL 行内、发送按钮左侧加两个 a-select（`size="small"` 或默认，风格与 method 下拉一致）：

```vue
<a-select
  data-testid="debug-env-select"
  :value="debug.selectedEnvName ?? ''"
  :options="[{ label: t('editor.noEnv'), value: '' }, ...editor.envs.map((e) => ({ label: e.name, value: e.name }))]"
  style="min-width: 120px"
  @update:value="(v: string) => debug.selectEnv(v === '' ? null : v)"
/>
<a-select
  data-testid="debug-case-select"
  :value="debug.selectedCaseId ?? editor.api?.cases[0]?.id ?? ''"
  :options="(editor.api?.cases ?? []).map((c) => ({ label: `${c.name}（${c.scope}）`, value: c.id }))"
  style="min-width: 160px"
  @update:value="(v: string) => debug.selectCase(v)"
/>
```

i18n 增 `editor.noEnv`（"无环境" / "No env"）。send 按钮 onClick 不变（`debug.send(editor)` 走 store 状态）。

- [ ] **步骤 4：组件测试（components.test.ts 追加）**

挂载 RequestEditor（mountWith 装配 store），选择 env/case 后点 send，断言 memory api.debugSend 收到的 input 含 envName/caseId（memory 替身已记录调用或经 spy 覆写）。

- [ ] **步骤 5：运行验证通过 + Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): 调试视图环境选择器与用例选择器（选择状态入 store、失效回退）"
```

---

### 任务 2：TopBar 语言/主题切换现代化

**文件：**
- 修改：`src/renderer/src/components/ThemeLanguageToggle.vue`、`src/renderer/src/i18n/{zh-CN,en}.json`
- 测试：`tests/renderer/components/antd-linkage.test.ts`、`tests/renderer/App.test.ts`、`tests/renderer/components/ThemeLanguageToggle.test.ts`

- [ ] **步骤 1：重写组件**

```vue
<script setup lang="ts">
import { computed } from "vue";
import { Dropdown, Menu, MenuItem, Segmented, Button } from "ant-design-vue";
import { GlobalOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import { LOCALES, useLocale } from "../i18n/bridge.js";
import { applyTheme, savePreference, themePreference, resolveTheme, type Theme } from "../theme.js";

const { t } = useI18n();
const { locale, setLocale } = useLocale();
const langLabel = computed(() => (locale.value === "zh-CN" ? "中文" : "English"));
const themeOptions = computed(() => [
  { label: t("app.themeAuto"), value: "system" },
  { label: t("app.themeLight"), value: "light" },
  { label: t("app.themeDark"), value: "dark" },
]);
function onThemeChange(value: unknown) {
  const preference = value as Theme;
  savePreference(preference);
  applyTheme(preference, window.matchMedia("(prefers-color-scheme: dark)").matches);
}
</script>

<template>
  <div class="toggles">
    <Dropdown>
      <Button data-testid="lang-toggle" size="small">
        <GlobalOutlined />
        {{ langLabel }}
      </Button>
      <template #overlay>
        <Menu @click="({ key }: { key: string | number }) => setLocale(key as never)">
          <MenuItem v-for="l in LOCALES" :key="l" data-testid="lang-option" :data-locale="l">
            <span :style="l === locale ? 'font-weight:600' : ''">{{ l === "zh-CN" ? "中文" : "English" }}</span>
          </MenuItem>
        </Menu>
      </template>
    </Dropdown>
    <Segmented
      data-testid="theme-toggle"
      size="small"
      :options="themeOptions"
      :value="themePreference"
      @change="onThemeChange"
    />
  </div>
</template>
```

实现注意：① antd 组件直接具名导入（任务 1 既有先例，不用 a- 前缀解析）；② 主题高亮项随 `themePreference`（任务 1 已是响应式 ref）受控——`savePreference` 已同步 ref；③ 旧 `nextTheme/nextLocale` 循环逻辑删除。

i18n 增键：`app.themeAuto`（"自动"/"Auto"）、`app.themeLight`（"亮色"/"Light"）、`app.themeDark`（"暗色"/"Dark"）。旧 `app.language`/`app.theme` 保留（tooltip/title 用途可留可删，两语言同构即可）。

- [ ] **步骤 2：适配测试**

- `antd-linkage.test.ts`：语言用例改为点击 lang-toggle 后点击 menu item（portal 到 body，用 expectBody 式查询或 `document.body.querySelector('[data-locale="en"]')`）；主题用例改为对 Segmented 组件触发 change（`findComponent(Segmented).vm.$emit('change', 'light')` 或点击 option 元素）——断言不变（currentLocale/themePreference 变化）。
- `ThemeLanguageToggle.test.ts`：主题循环用例改为三次 change 调用断言 data-theme 依次 light→dark→…（system 起始时 resolveTheme 按 matchMedia stub）。
- `App.test.ts` 的语言切换用例（暂无数据 → No data）：改为点 lang-toggle 后点英文菜单项。

- [ ] **步骤 3：运行验证通过 + Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): TopBar 语言/主题切换现代化（下拉菜单 + 分段选择器）"
```

---

### 任务 3：打包补全（元数据 / 自绘图标 / asar 瘦身）

**文件：**
- 修改：`apps/desktop/package.json`（description/author；vue/pinia/vue-i18n/ant-design-vue/@ant-design/icons-vue 移 devDependencies；增 `gen:icon` 脚本）
- 创建：`apps/desktop/scripts/gen-icon.mjs`、`apps/desktop/build/icon.png`（生成产物，入库）
- 测试/验证：无新单测；门禁 + 打包冒烟为验证

- [ ] **步骤 1：元数据与依赖归位**

package.json：`"description": "开源、本地优先的 API 全生命周期平台（接口定义 · 调试 · 测试 · 设计导出）"`、`"author": "autumnharvestc"`。依赖归位（`pnpm remove X` 后 `pnpm add -D X`）：`vue`、`pinia`、`vue-i18n`、`ant-design-vue`、`@ant-design/icons-vue` → devDependencies（vite 打包进 dist-renderer，主进程运行时不需要）；`@apicc/core` 保持 dependencies。**归位后必须全量验证**（desktop 测试 + build + dist:dir + smoke:dir）——任何主进程对上述包的意外引用会在此暴露。

- [ ] **步骤 2：自绘图标（程序化生成，素材合规）**

`scripts/gen-icon.mjs`（devDep `pngjs`）：512×512 纯几何绘制——圆角方形背景（竖向琥珀渐变 #d97706→#92400e，逐像素插值；圆角判定 distance-to-rounded-rect）+ 白色抽象标记（圆环 + 斜向圆角短棒，均为 distance-to-segment/圆数学，**无文字、无第三方素材**，纯原创）。输出 `build/icon.png`（electron-builder 默认 buildResources 约定，win 打包自动生成 ico）。`package.json` 增 `"gen:icon": "node scripts/gen-icon.mjs"`。commit 同时入库脚本与生成产物。报告注明：素材 100% 程序化生成、零第三方素材（合规约束 asset-license-compliance 落实记录）。

- [ ] **步骤 3：验证**

```bash
pnpm -C apps/desktop gen:icon && pnpm -C apps/desktop dist:dir && pnpm -C apps/desktop run smoke:dir
```

预期：apicc.exe 使用新图标（资源管理器可见）；smoke:dir 三检全过；报告中记录 asar 体积前后对比（基线 ~116MB）。若依赖归位后打包缺模块（报 Cannot find module），把对应包移回 dependencies 并在报告说明原因。

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop
git commit -m "build(desktop): 应用元数据与自绘图标、renderer 依赖归位 asar 瘦身"
```

---

## 自检结果

1. **覆盖度**：用户两项新需求均已归档（自动升级→分发阶段记忆；素材合规→记忆+任务 3 落实）；M1 收口三件套全覆盖（任务 1=最终审查 Important 2，任务 2=用户截图反馈，任务 3=分发前必补）。M2 范围未混入。
2. **占位符扫描**：任务 1/2 全代码；任务 3 图标为程序化绘制规格（几何定义明确），无 TODO。
3. **类型一致性**：debug store 新状态与 send 签名兼容既有测试（显式 envName 参数优先级保持）；ThemeLanguageToggle 对外无 props/emit（自包含），App 装配不受影响。
