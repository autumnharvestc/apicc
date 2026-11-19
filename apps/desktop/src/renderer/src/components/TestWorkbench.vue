<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { TestingPane } from "../../../shared/testing.js";

type Page = TestingPane | "stress";
const props = defineProps<{ pane: Page; online?: boolean }>();
defineEmits<{ "update:pane": [page: Page] }>();
const { t } = useI18n();
const pages = computed<Page[]>(() => props.online
  ? ["api-cases", "suites", "datasets", "stress"] : ["api-cases", "scenario", "suites", "datasets"]);
const labels = { "api-cases": "test.apiCases", scenario: "test.scenarios", suites: "testing.suites", datasets: "testing.datasets", stress: "testPresentation.stressPlan" };
</script>
<template>
  <section class="test-workbench" data-testid="test-workbench">
    <header>
      <h1 data-testid="sider-title">{{ t("nav.test") }}</h1>
      <nav :aria-label="t('nav.test')">
        <button v-for="page in pages" :key="page" type="button" :data-testid="`test-tab-${page}`"
          :class="{active: pane === page}" :aria-current="pane === page ? 'page' : undefined" @click="$emit('update:pane', page)">{{ t(labels[page]) }}</button>
      </nav>
    </header>
    <div class="test-columns" :class="{ 'case-columns': pane === 'api-cases', 'single-column': !$slots.navigation }">
      <slot name="navigation" /><main><slot /></main>
    </div>
  </section>
</template>
<style scoped>
.test-workbench { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; background: var(--workbench-background); container-type: inline-size; }
header { flex: none; border-bottom: 1px solid var(--border); }
h1 { margin: 0; padding: 12px 17px 3px; font-size: 22px; line-height: 1.35; font-weight: 650; color: var(--text); }
nav { display: flex; padding-inline: 10px; overflow-x: auto; }
nav button { font: inherit; font-weight: 500; cursor: pointer; flex: none; padding: 7px 13px 8px; color: var(--text); border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: transparent; }
nav button[aria-current] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 650; }
.test-columns { flex: 1; display: grid; grid-template-columns: minmax(155px,26%) minmax(0,1fr); min-height: 0; gap: 7px; padding: 9px; }
.case-columns { grid-template-columns: minmax(138px,20.7%) minmax(0,1fr); }
.single-column { grid-template-columns: minmax(0,1fr); }
main { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: auto; }
@container (max-width: 650px) { .test-columns:not(.single-column) { grid-template-columns: minmax(115px,25%) minmax(0,1fr); padding: 5px; gap: 4px; } }
</style>
