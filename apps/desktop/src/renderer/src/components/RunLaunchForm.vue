<script setup lang="ts">
import { computed, useId } from "vue";
import { SearchOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import type { LaunchChoice, LaunchKind } from "../execution/launch.js";
import { useLaunchMessages } from "../execution/launchMessages.js";

const props = defineProps<{
  kinds: readonly LaunchKind[];
  choices: readonly LaunchChoice[];
  kind: LaunchKind;
  selected: string;
  search: string;
  reason?: string;
  notice?: string;
  busy?: boolean;
  loading?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  "update:kind": [value: LaunchKind];
  "update:selected": [value: string];
  "update:search": [value: string];
  launch: [];
}>();
const label = useLaunchMessages();
const { t } = useI18n();
const radioGroup = useId();
const targets = computed(() => {
  const query = props.search.trim().toLocaleLowerCase();
  return props.choices.filter(item => !query || [item.label, item.detail, item.modulePath].some(value => value?.toLocaleLowerCase().includes(query)));
});
const selectedTarget = computed(() => props.choices.find(item => item.id === props.selected));
const searchLabel = computed(() => t(`runWorkbench.search.${props.kind}`));
</script>

<template>
  <div class="launch-form" data-testid="run-launch-form">
    <section class="launch-card">
      <header class="card-heading"><h2>{{ label("choose") }}</h2><button v-if="selectedTarget" class="clear-target" type="button" data-testid="launch-clear" :title="t('testAssets.clear')" :aria-label="t('testAssets.clear')" @click="emit('update:selected', '')">×</button></header>
      <label class="type-control">
        <span>{{ label("type") }}</span>
        <select :value="kind" data-testid="launch-kind" @change="emit('update:kind', ($event.target as HTMLSelectElement).value as LaunchKind)">
          <option v-for="value in kinds" :key="value" :value="value">{{ label(value) }}</option>
        </select>
      </label>
      <label class="target-search"><SearchOutlined aria-hidden="true" /><input :value="search" type="search" :placeholder="searchLabel" :aria-label="searchLabel" data-testid="launch-search" @input="emit('update:search', ($event.target as HTMLInputElement).value)" /></label>
      <div v-if="targets.length" class="target-list" role="radiogroup" :aria-label="label('choose')">
        <label v-for="item in targets" :key="item.id" class="target-row" :class="{ selected: selected === item.id }" :title="[item.modulePath, item.label, item.detail].filter(Boolean).join(' / ')">
          <input type="radio" :name="radioGroup" :checked="selected === item.id" :value="item.id" data-testid="launch-target" @click="selected === item.id && emit('update:selected', '')" @change="emit('update:selected', item.id)" />
          <span>
            <strong>{{ item.label }}</strong>
            <small v-if="item.detail">{{ item.detail }}</small>
          </span>
        </label>
      </div>
      <p v-else class="secondary" role="status">{{ loading ? label('loading') : label('noTargets') }}</p>
    </section>
    <section class="launch-card launch-preview">
      <h2>{{ label("thisRun") }}</h2>
      <div class="preview-body"><template v-if="selectedTarget">
        <h3>{{ selectedTarget.label }}</h3>
        <slot />
      </template>
      <p v-else class="secondary">{{ t(`runWorkbench.pick.${kind}`) }}</p>
      <p v-if="notice" class="launch-notice" role="status">{{ notice }}</p></div>
      <footer class="launch-controls">
        <p v-if="reason || loading || busy" class="secondary" role="status">{{ reason || (busy ? label('busy') : label('loading')) }}</p>
        <slot name="actions" />
        <button type="button" class="launch-primary" :disabled="!selectedTarget || !!reason || loading || busy || disabled" data-testid="run-btn" @click="emit('launch')">
          {{ label(`start.${kind}`) }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.launch-form { box-sizing: border-box; flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.28fr) minmax(0, 1fr); gap: 8px; padding: 9px; }
.launch-card { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: auto; border: 1px solid var(--border); border-radius: 7px; padding: 13px 14px 16px; background: var(--bg); }
h2, h3, p { margin: 0; }
h2 { font-size: 18px; font-weight: 650; line-height: 1.4; }
h3 { font-size: 22px; line-height: 1.35; overflow-wrap: anywhere; }
.card-heading { display: flex; align-items: center; justify-content: space-between; }
.clear-target { padding: 0 5px; background: transparent; border: 0; color: var(--text-muted); cursor: pointer; font-size: 18px; }
.type-control { display: grid; grid-template-columns: minmax(max-content, 16%) minmax(0,1fr); align-items: center; margin: 17px 0 22px; }
.type-control select, .target-search { box-sizing: border-box; width: 100%; color: inherit; background: var(--bg); border: 1px solid var(--border); border-radius: 5px; padding: 5px 9px; font: inherit; min-height: 31px; }
.target-search { display: flex; flex: none; align-items: center; gap: 9px; margin-bottom: 16px; background: var(--workbench-background); color: var(--text-muted); }
.target-search:focus-within { outline: 1px solid var(--accent); }
.target-search input { padding: 0; border: 0; background: transparent; color: var(--text); font: inherit; flex: 1; min-width: 0; outline: 0; }
.target-list { flex: 0 1 auto; min-height: 65px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.target-row { display: flex; min-height: 34px; align-items: center; gap: 13px; padding: 5px 15px; cursor: pointer; overflow-wrap: anywhere; }
.target-row + .target-row { border-top: 1px solid var(--border); }
.target-row.selected { background: color-mix(in srgb, var(--accent) 12%, var(--bg)); box-shadow: inset 4px 0 var(--accent); }
.target-row input { width: 15px; height: 15px; margin: 0; flex: none; accent-color: var(--accent); }
.target-row strong { font-weight: 550; }
.target-row small { display: block; color: var(--text-muted); }
.secondary { color: var(--text-muted); }
.preview-body { flex: 1 1 auto; min-height: 0; overflow: auto; margin-top: 16px; }
.preview-body > * + * { margin-top: 13px; }
.launch-notice { overflow-wrap: anywhere; }
.launch-controls { flex: none; display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 12px; }
.launch-controls p { flex: 1 0 10em; }
.launch-primary { min-height: 35px; min-width: 104px; background: var(--accent); color: white; border: 1px solid transparent; border-radius: 5px; padding: 6px 16px; cursor: pointer; font: inherit; font-weight: 600; }
.launch-primary:disabled { background: var(--border); color: var(--text-muted); cursor: default; }
.launch-preview :deep(dl) { display: grid; grid-template-columns: minmax(max-content, 28%) minmax(0, 1fr); border-top: 1px solid var(--border); margin: 13px 0; }
.launch-preview :deep(dt), .launch-preview :deep(dd) { margin: 0; border-bottom: 1px solid var(--border); padding: 4px; overflow-wrap: anywhere; }
@container (max-width: 640px) { .launch-form { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(230px,1fr); overflow-y: auto; } .target-list { max-height: 160px; } .launch-card { overflow: visible; } .preview-body { overflow: visible; } .type-control { margin: 9px 0; } .target-search { margin-bottom: 8px; } }
</style>
