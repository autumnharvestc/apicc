<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { generateRequestSnippet } from "@apicc/core/design/document";
import type { DocumentApi, RequestSnippetLanguage } from "@apicc/core";
import { useI18n } from "vue-i18n";

const props = defineProps<{ api: DocumentApi }>();
const { t } = useI18n();
const language = ref<RequestSnippetLanguage>("curl-posix");
const snippet = computed(() => generateRequestSnippet(props.api, language.value));

async function copySnippet() {
  if (!snippet.value.code) return;
  try {
    await navigator.clipboard.writeText(snippet.value.code);
    void message.success(t("design.snippetCopied"));
  } catch {
    void message.error(t("design.snippetCopyFailed"));
  }
}
</script>

<template>
  <section class="code-snippet" data-testid="code-snippet-panel">
    <div class="snippet-toolbar">
      <label for="snippet-language">{{ t("design.snippetLanguage") }}</label>
      <select id="snippet-language" v-model="language" data-testid="snippet-language">
        <option value="curl-posix">{{ t("design.snippetLanguages.curl") }}</option>
        <option value="powershell">{{ t("design.snippetLanguages.powershell") }}</option>
        <option value="javascript-fetch">{{ t("design.snippetLanguages.javascript") }}</option>
      </select>
      <button type="button" data-testid="snippet-copy" :disabled="!snippet.code" @click="copySnippet">{{ t("design.snippetCopy") }}</button>
    </div>
    <p class="snippet-help">{{ t("design.snippetPlaceholderHelp") }}</p>
    <pre v-if="snippet.code" data-testid="snippet-code"><code>{{ snippet.code }}</code></pre>
    <p v-else class="snippet-unsupported" data-testid="snippet-unsupported">{{ t("design.snippetUnsupported") }}</p>
    <ul v-if="snippet.diagnostics.length" class="snippet-diagnostics" data-testid="snippet-diagnostics">
      <li v-for="(diagnostic, index) in snippet.diagnostics" :key="`${diagnostic.code}:${diagnostic.path}:${index}`" :class="`diagnostic-${diagnostic.severity}`">
        {{ diagnostic.message }} <code v-if="diagnostic.path">{{ diagnostic.path }}</code>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.code-snippet { border: 1px solid var(--border, #d9d9d9); border-radius: 4px; padding: 8px; min-width: 0; }
.snippet-toolbar { display: flex; align-items: center; gap: 8px; }
.snippet-toolbar label { font-weight: 600; }
.snippet-toolbar select { min-width: 160px; }
.snippet-toolbar button { margin-left: auto; }
.snippet-help { color: var(--text-muted); font-size: 12px; margin: 6px 0; }
.code-snippet pre { overflow: auto; white-space: pre; margin: 0; padding: 8px; background: var(--panel, #f5f5f5); font-size: 12px; }
.snippet-unsupported { color: var(--text-muted); }
.snippet-diagnostics { padding-left: 20px; font-size: 12px; }
.diagnostic-error { color: var(--fail, #cf1322); }
.diagnostic-warning { color: var(--warning, #d48806); }
</style>
