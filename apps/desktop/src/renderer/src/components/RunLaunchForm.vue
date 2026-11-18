<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import type { LaunchChoice, LaunchKind } from "../execution/launch.js";
import { useLaunchMessages } from "../execution/launchMessages.js";

const props = defineProps<{
  kinds: readonly LaunchKind[];
  choices: readonly LaunchChoice[];
  kind: LaunchKind;
  selected: string;
  reason?: string;
  notice?: string;
  busy?: boolean;
  loading?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  "update:kind": [value: LaunchKind];
  "update:selected": [value: string];
  launch: [];
}>();
const label = useLaunchMessages();
const search = ref(""), radioGroup = useId();
const targets = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return props.choices.filter(item => !query || [item.label, item.detail].some(value => value?.toLocaleLowerCase().includes(query)));
});
const selectedTarget = computed(() => props.choices.find(item => item.id === props.selected));
watch(() => props.kind, () => { search.value = ""; });
</script>

<template>
  <div class="launch-form" data-testid="run-launch-form">
    <section class="launch-card">
      <h2>{{ label("choose") }}</h2>
      <label class="type-control">
        <span>{{ label("type") }}</span>
        <select :value="kind" data-testid="launch-kind" @change="emit('update:kind', ($event.target as HTMLSelectElement).value as LaunchKind)">
          <option v-for="value in kinds" :key="value" :value="value">{{ label(value) }}</option>
        </select>
      </label>
      <input v-model="search" type="search" :placeholder="label('search')" :aria-label="label('search')" data-testid="launch-search" />
      <div v-if="targets.length" class="target-list" role="radiogroup" :aria-label="label('choose')">
        <label v-for="item in targets" :key="item.id" class="target-row" :class="{ selected: selected === item.id }">
          <input type="radio" :name="radioGroup" :checked="selected === item.id" :value="item.id" data-testid="launch-target" @change="emit('update:selected', item.id)" />
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
      <template v-if="selectedTarget">
        <h3>{{ selectedTarget.label }}</h3>
        <slot />
      </template>
      <p v-else class="secondary">{{ label("pick") }}</p>
      <p v-if="notice" class="launch-notice" role="status">{{ notice }}</p>
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
.launch-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.08fr); gap: 12px; align-items: stretch; }
.launch-card { min-width: 0; display: flex; flex-direction: column; gap: 12px; border: 1px solid var(--border); border-radius: 8px; padding: 16px; background: var(--bg); }
h2, h3, p { margin: 0; }
h2 { font-size: 17px; }
h3 { font-size: 19px; overflow-wrap: anywhere; }
.type-control { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; }
.type-control select { flex: 1; min-width: 120px; }
.type-control select, input[type="search"] { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px; }
.target-list { border: 1px solid var(--border); border-radius: 6px; max-height: 360px; overflow: auto; }
.target-row { display: flex; align-items: center; gap: 9px; padding: 9px 10px; cursor: pointer; overflow-wrap: anywhere; }
.target-row + .target-row { border-top: 1px solid var(--border); }
.target-row.selected { background: color-mix(in srgb, var(--accent, #1677ff) 12%, transparent); box-shadow: inset 3px 0 var(--accent, #1677ff); }
.target-row strong { font-weight: 500; }
.target-row small { display: block; color: var(--text-muted); }
.secondary { color: var(--text-muted); }
.launch-notice { overflow-wrap: anywhere; }
.launch-controls { margin-top: auto; padding-top: 8px; display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 8px; }
.launch-controls p { flex: 1 0 10em; }
.launch-primary { background: var(--accent, #1677ff); color: white; border: 1px solid transparent; border-radius: 6px; padding: 7px 12px; min-height: 32px; cursor: pointer; font: inherit; }
.launch-primary:disabled { opacity: .6; cursor: default; }
.launch-preview :deep(dl) { display: grid; grid-template-columns: max-content minmax(0, 1fr); margin: 0; }
.launch-preview :deep(dt), .launch-preview :deep(dd) { margin: 0; border-bottom: 1px solid var(--border); padding: 5px 8px; overflow-wrap: anywhere; }
.launch-preview :deep(dt) { color: var(--text-muted); }
@media (max-width: 850px) { .launch-form { grid-template-columns: minmax(0, 1fr); } .target-list { max-height: 220px; } }
</style>
