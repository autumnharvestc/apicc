<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { CheckOutlined } from "@ant-design/icons-vue";

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  label: string;
  testId?: string;
  items: readonly { key: string; label: string; checked?: boolean; disabled?: boolean; testId?: string; locale?: string; divider?: boolean; danger?: boolean }[];
  disabled?: boolean;
  hidden?: boolean;
}>();
const emit = defineEmits<{ select: [key: string]; opened: [] }>();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const open = ref(false);
const position = ref({ top: "0px", left: "0px", maxHeight: "0px" });
const buttons = () => Array.from(menu.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);

function placeMenu() {
  if (!trigger.value || !menu.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const width = menu.value.offsetWidth;
  const below = window.innerHeight - rect.bottom - 8;
  const above = rect.top - 8;
  const openUp = below < Math.min(menu.value.scrollHeight, 160) && above > below;
  const height = Math.max(0, openUp ? above : below);
  position.value = {
    top: `${openUp ? Math.max(4, rect.top - Math.min(menu.value.scrollHeight, height) - 4) : rect.bottom + 4}px`,
    left: `${Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4))}px`,
    maxHeight: `${height}px`,
  };
}

async function show(last = false) {
  if (props.disabled || props.hidden) return;
  emit("opened");
  open.value = true;
  await nextTick();
  placeMenu();
  const items = buttons();
  (last ? items.at(-1) : items[0])?.focus({ preventScroll: true });
}

function close(restoreFocus = true) {
  if (!open.value) return;
  open.value = false;
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}

function toggle() {
  if (open.value) close();
  else void show();
}

function choose(key: string) {
  if (!open.value || props.disabled || props.hidden) return;
  close();
  emit("select", key);
}

function onMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" || event.key === "Tab") {
    close();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  const items = buttons();
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  let target: HTMLButtonElement | undefined;
  if (event.key === "ArrowDown") target = items[(index + 1) % items.length];
  else if (event.key === "ArrowUp") target = items[(index + items.length - 1) % items.length];
  else if (event.key === "Home") target = items[0];
  else if (event.key === "End") target = items.at(-1);
  if (target) { event.preventDefault(); target.focus(); }
}

function outside(event: PointerEvent) {
  const target = event.target as Node;
  if (!trigger.value?.contains(target) && !menu.value?.contains(target)) {
    // An outside button or input will take focus through the normal click.
    close();
  }
}

function stopListening() {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", placeMenu);
  window.removeEventListener("scroll", placeMenu, true);
}
watch(open, (visible) => {
  if (!visible) { stopListening(); return; }
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", placeMenu);
  window.addEventListener("scroll", placeMenu, true);
});
onBeforeUnmount(stopListening);
watch(() => props.hidden, (hidden) => { if (hidden) close(false); }, { flush: "sync" });
defineExpose({ close, hasFocus: () => open.value || trigger.value === document.activeElement });
</script>

<template>
  <button
    ref="trigger"
    v-bind="$attrs"
    type="button"
    class="menu-trigger"
    :data-testid="testId"
    :aria-label="label"
    :title="label"
    aria-haspopup="menu"
    :aria-expanded="open"
    :disabled="disabled"
    @click="toggle"
    @keydown.down.prevent="show()"
    @keydown.up.prevent="show(true)"
  ><slot>{{ label }}</slot></button>
  <Teleport to="body">
    <div v-if="open" ref="menu" class="action-menu" role="menu" :aria-label="label" :data-menu-owner="testId" :style="position" @keydown="onMenuKeydown">
      <button
        v-for="item in props.items"
        :key="item.key"
        type="button"
        :role="item.checked === undefined ? 'menuitem' : 'menuitemradio'"
        :aria-checked="item.checked"
        :disabled="item.disabled"
        :class="{ 'menu-divider': item.divider, 'menu-danger': item.danger }"
        :data-testid="item.testId"
        :data-locale="item.locale"
        tabindex="-1"
        @click="choose(item.key)"
      >
        <span v-if="item.checked !== undefined" class="menu-check"><CheckOutlined v-if="item.checked" /></span>
        <span>{{ item.label }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.menu-trigger {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 30px;
  min-height: 30px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--control-radius, 6px);
  background: transparent;
  color: var(--text);
  font: inherit;
  cursor: pointer;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.menu-trigger:hover,
.menu-trigger[aria-expanded="true"] { background: var(--active-weak); }
.menu-trigger:focus-visible { outline-offset: -2px; }
.menu-trigger:disabled { opacity: 0.5; cursor: default; }
.action-menu {
  position: fixed;
  z-index: 1100;
  min-width: 150px;
  max-width: calc(100vw - 8px);
  box-sizing: border-box;
  padding: 4px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--control-radius, 6px);
  background: var(--bg);
  color: var(--text);
  box-shadow: 0 4px 14px rgb(0 0 0 / 18%);
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.action-menu button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.action-menu button:hover,
.action-menu button:focus-visible { background: var(--active-weak); }
.action-menu button:focus-visible { outline-offset: -2px; }
.action-menu button:disabled { opacity: 0.55; cursor: default; }
.action-menu .menu-divider { border-top: 1px solid var(--border); margin-top: 3px; padding-top: 6px; border-radius: 0; }
.action-menu .menu-danger { color: var(--fail); }
.menu-check { display: inline-block; flex: 0 0 14px; color: var(--accent); }
@media (forced-colors: active) {
  .action-menu, .menu-trigger { border-color: ButtonText; }
}
</style>
