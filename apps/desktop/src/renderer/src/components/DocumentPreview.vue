<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DocumentApi } from "@apicc/core";
import type { DesignPreviewResult } from "../../../shared/design.js";
import CodeSnippetPanel from "./CodeSnippetPanel.vue";

const props = defineProps<{
  status: "idle" | "loading" | "ready" | "invalid" | "conflict";
  result: DesignPreviewResult | null;
  error?: string;
}>();
const { t } = useI18n();
const ready = computed(() => props.result?.status === "ready" ? props.result : null);

type Parameter = DocumentApi["request"]["pathParams"][number];
function parametersFor(api: DocumentApi): Array<{ label: string; rows: Parameter[] }> {
  const request = api.request;
  return [
    { label: t("design.parameter.path"), rows: request.pathParams },
    { label: t("design.parameter.query"), rows: request.query },
    { label: t("design.parameter.header"), rows: request.headers },
    { label: t("design.parameter.cookie"), rows: request.cookies },
  ].filter((group) => group.rows.length > 0);
}

function authDescription(api: DocumentApi): string {
  const auth = api.request.auth;
  switch (auth.kind) {
    case "none": return t("design.authNone");
    case "bearer": return t("design.authBearerPlaceholder");
    case "basic": return t("design.authBasicPlaceholder");
    case "apikey": return t("design.authApiKeyPlaceholder", { name: auth.name, placement: auth.placement });
    case "unresolved": return t("design.authUnresolvedComponent", { id: auth.componentId });
  }
}

function modelReferences(value: unknown): Array<{ id: string; name: string }> {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, unknown>;
    if (record.kind === "modelRef" && typeof record.modelId === "string") ids.add(record.modelId);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...ids].map((id) => ({ id, name: ready.value?.projection.apis.flatMap((api) => api.models).find((model) => model.id === id)?.name ?? id }));
}

function parameterName(parameter: Parameter): string {
  return parameter.kind === "unresolved" ? t("design.missingParameter", { id: parameter.componentId }) : parameter.name;
}

function parameterValue(parameter: Parameter): string {
  return parameter.kind === "unresolved" ? "—" : parameter.value ?? "—";
}

function pretty(value: unknown): string { return JSON.stringify(value, null, 2); }
</script>

<template>
  <section class="document-preview" data-testid="design-document-preview" :data-status="status" aria-live="polite">
    <header class="preview-heading">
      <strong>{{ t('design.previewTitle') }}</strong>
      <span class="status" :class="`status-${status}`" data-testid="design-preview-status">{{ t(`design.previewStatus.${status}`) }}</span>
    </header>

    <p v-if="status === 'idle'">{{ t('design.previewIdle') }}</p>
    <p v-else-if="status === 'loading'">{{ t('design.previewLoading') }}</p>
    <p v-else-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="ready">
      <dl class="provenance" data-testid="design-preview-provenance">
        <dt>{{ t('design.previewSource') }}</dt><dd>{{ t('design.previewSourceDraft') }}</dd>
        <dt>{{ t('design.savedRevision') }}</dt><dd data-testid="design-saved-revision">{{ ready.sourceProjectRevision }}</dd>
        <dt>{{ t('design.projectionRevision') }}</dt><dd>{{ ready.projection.sourceProjectRevision }}</dd>
        <dt>{{ t('design.apiRevision') }}</dt><dd>{{ ready.sourceApiRevision }}</dd>
      </dl>

      <article v-for="api in ready.projection.apis" :key="api.contractId" class="document-api" data-testid="design-readable-document">
        <h3>{{ api.metadata.name }}</h3>
        <p v-if="api.metadata.description" class="description">{{ api.metadata.description }}</p>

        <section class="document-section">
          <h4>{{ t('design.metadataSection') }}</h4>
          <dl class="metadata-grid">
            <dt>{{ t('design.apiName') }}</dt><dd>{{ api.metadata.name }}</dd>
            <dt>{{ t('design.description') }}</dt><dd>{{ api.metadata.description || '—' }}</dd>
            <dt>{{ t('design.version') }}</dt><dd>{{ api.metadata.version || '—' }}</dd>
            <dt>{{ t('design.lifecycle') }}</dt><dd>{{ api.metadata.status }}</dd>
            <dt>{{ t('design.tags') }}</dt><dd>{{ api.metadata.tags.join(', ') || '—' }}</dd>
            <dt>{{ t('design.collection') }}</dt><dd>{{ api.collection.name }}</dd>
            <dt>{{ t('design.folders') }}</dt><dd>{{ api.folders.map((folder) => folder.name).join(' / ') || '—' }}</dd>
          </dl>
        </section>

        <section class="document-section">
          <h4>{{ t('design.requestSection') }}</h4>
          <p class="request-line"><code>{{ api.request.protocol.toUpperCase() }}</code><template v-if="api.request.protocol !== 'websocket'"> · <code>{{ api.request.method }}</code></template> {{ api.request.baseUrl }}{{ api.request.path }}</p>
          <p>{{ t('design.authKind') }}: {{ authDescription(api) }}</p>
          <div v-for="group in parametersFor(api)" :key="group.label" class="parameter-group">
            <h5>{{ group.label }}</h5>
            <div class="table-scroll">
              <table>
                <thead><tr><th>{{ t('design.parameter.name') }}</th><th>{{ t('design.parameter.value') }}</th><th>{{ t('design.required') }}</th><th>{{ t('design.enabled') }}</th><th>{{ t('design.description') }}</th><th>{{ t('design.parameter.schema') }}</th></tr></thead>
                <tbody>
                  <tr v-for="parameter in group.rows" :key="parameter.id">
                    <td>{{ parameterName(parameter) }}</td>
                    <td class="preserve-whitespace">{{ parameterValue(parameter) }}</td>
                    <td>{{ parameter.kind === 'unresolved' ? '—' : parameter.required ? t('design.yes') : t('design.no') }}</td>
                    <td>{{ parameter.kind === 'unresolved' ? '—' : parameter.enabled ? t('design.yes') : t('design.no') }}</td>
                    <td>{{ parameter.kind === 'unresolved' ? '—' : parameter.description || '—' }}</td>
                    <td v-if="parameter.kind !== 'unresolved'">
                      <pre class="definition-code" data-testid="document-parameter-schema">{{ pretty(parameter.schema) }}</pre>
                      <p v-if="modelReferences(parameter.schema).length" class="model-references">
                        <a v-for="reference in modelReferences(parameter.schema)" :key="reference.id" :href="`#model-${reference.id}`">{{ reference.name }}</a>
                      </p>
                    </td>
                    <td v-else>—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="body-definition">
            <h5>{{ t('design.bodySection') }}</h5>
            <template v-if="api.request.protocol === 'http'">
              <p v-if="api.request.body.kind === 'none'">{{ t('design.noBody') }}</p>
              <template v-else-if="api.request.body.kind === 'json' || api.request.body.kind === 'xml' || api.request.body.kind === 'text'">
                <pre class="definition-code">{{ api.request.body.content }}</pre>
                <template v-if="api.request.body.schema">
                  <h6>{{ t('design.bodySchema') }}</h6>
                  <pre class="definition-code" data-testid="document-body-schema">{{ pretty(api.request.body.schema) }}</pre>
                  <p v-if="modelReferences(api.request.body.schema).length" class="model-references">
                    <a v-for="reference in modelReferences(api.request.body.schema)" :key="reference.id" :href="`#model-${reference.id}`">{{ reference.name }}</a>
                  </p>
                </template>
              </template>
              <template v-else-if="api.request.body.kind === 'graphql'">
                <p v-if="api.request.body.operationName">{{ t('design.graphqlOperationName') }}: {{ api.request.body.operationName }}</p>
                <pre class="definition-code">{{ api.request.body.query }}</pre>
                <pre v-if="api.request.body.variables" class="definition-code">{{ api.request.body.variables }}</pre>
              </template>
              <div v-else-if="api.request.body.kind === 'urlencoded'" class="table-scroll">
                <table><thead><tr><th>{{ t('design.parameter.name') }}</th><th>{{ t('design.parameter.value') }}</th><th>{{ t('design.enabled') }}</th></tr></thead>
                  <tbody><tr v-for="field in api.request.body.fields" :key="field.id"><td>{{ field.name }}</td><td class="preserve-whitespace">{{ field.value }}</td><td>{{ field.enabled ? t('design.yes') : t('design.no') }}</td></tr></tbody>
                </table>
              </div>
              <div v-else-if="api.request.body.kind === 'multipart'" class="table-scroll">
                <table><thead><tr><th>{{ t('design.parameter.name') }}</th><th>{{ t('design.kind') }}</th><th>{{ t('design.parameter.value') }}</th><th>{{ t('design.contentType') }}</th><th>{{ t('design.enabled') }}</th></tr></thead>
                  <tbody><tr v-for="entry in api.request.body.entries" :key="entry.id"><td>{{ entry.name }}</td><td>{{ entry.kind }}</td><td>{{ entry.kind === 'file' ? (entry.filename || t('design.userSuppliedFile')) : entry.value }}</td><td>{{ entry.kind === 'file' ? (entry.contentType || '—') : '—' }}</td><td>{{ entry.enabled ? t('design.yes') : t('design.no') }}</td></tr></tbody>
                </table>
              </div>
              <p v-else-if="api.request.body.kind === 'binary'">{{ t('design.binaryFile') }}<template v-if="api.request.body.contentType"> · {{ api.request.body.contentType }}</template>{{ t('design.binaryFileRequired') }}</p>
            </template>
            <pre v-else-if="api.request.protocol === 'soap'" class="definition-code">{{ api.request.envelope }}</pre>
            <pre v-else class="definition-code">{{ api.request.message || '—' }}</pre>
          </div>
          <CodeSnippetPanel :api="api" />
        </section>

        <section v-if="api.responses.length" class="document-section">
          <h4>{{ t('design.responseSection') }}</h4>
          <article v-for="(response, responseIndex) in api.responses" :key="response.id" class="response-card">
            <template v-if="response.kind === 'unresolved'">
              <h5>{{ t('design.unresolvedResponse', { index: responseIndex + 1 }) }}</h5>
              <p>{{ t('design.missingComponent', { id: response.componentId }) }}</p>
            </template>
            <template v-else>
              <h5>{{ response.status }} <span v-if="response.description">· {{ response.description }}</span></h5>
              <div v-if="Object.keys(response.headers).length" class="table-scroll">
                <table><thead><tr><th>{{ t('design.parameter.name') }}</th><th>{{ t('design.parameter.value') }}</th></tr></thead><tbody>
                  <tr v-for="(value, name) in response.headers" :key="name"><td>{{ name }}</td><td>{{ value }}</td></tr>
                </tbody></table>
              </div>
              <div v-for="(content, mediaType) in response.content" :key="mediaType" class="response-content">
                <h6>{{ mediaType }}</h6>
                <pre v-if="content.schema" class="definition-code">{{ pretty(content.schema) }}</pre>
                <div v-if="content.examples.length" class="table-scroll">
                  <table><thead><tr><th>{{ t('design.example') }}</th><th>{{ t('design.parameter.value') }}</th></tr></thead><tbody>
                    <tr v-for="example in content.examples" :key="example.id"><td>{{ example.kind === 'unresolved' ? t('design.missingExample', { id: example.componentId }) : example.name }}</td><td class="preserve-whitespace">{{ example.kind === 'unresolved' ? '—' : pretty(example.value) }}</td></tr>
                  </tbody></table>
                </div>
              </div>
            </template>
          </article>
        </section>

        <section v-if="api.models.length" class="document-section">
          <h4>{{ t('design.modelSection') }}</h4>
          <article v-for="model in api.models" :id="`model-${model.id}`" :key="model.id" class="model-card">
            <h5>{{ model.name }}</h5>
            <p v-if="model.description">{{ model.description }}</p>
            <p v-if="modelReferences(model.schema).length" class="model-references">{{ t('design.references') }}
              <a v-for="reference in modelReferences(model.schema)" :key="reference.id" :href="`#model-${reference.id}`">{{ reference.name }}</a>
            </p>
            <pre class="definition-code">{{ pretty(model.schema) }}</pre>
          </article>
        </section>

        <section v-if="api.components.length" class="document-section">
          <h4>{{ t('design.componentSection') }}</h4>
          <div class="table-scroll"><table><thead><tr><th>{{ t('design.parameter.name') }}</th><th>{{ t('design.kind') }}</th><th>{{ t('design.description') }}</th><th>{{ t('design.definition') }}</th></tr></thead>
            <tbody><tr v-for="component in api.components" :key="component.id"><td>{{ component.name }}</td><td>{{ component.kind }}</td><td>{{ component.description || '—' }}</td><td class="preserve-whitespace">{{ pretty(component.definition) }}</td></tr></tbody>
          </table></div>
        </section>
        <section v-if="api.documentation" class="document-section"><h4>{{ t('design.documentationSection') }}</h4><p class="documentation">{{ api.documentation }}</p></section>
        <ul v-if="api.diagnostics.length" class="diagnostics" data-testid="design-preview-definition-diagnostics">
          <li v-for="(diagnostic, index) in api.diagnostics" :key="`${diagnostic.code}:${diagnostic.path}:${index}`" :class="`diagnostic-${diagnostic.severity}`">{{ diagnostic.message }} <code v-if="diagnostic.path">{{ diagnostic.path }}</code></li>
        </ul>
      </article>
      <ul v-if="ready.diagnostics.length" class="diagnostics" data-testid="design-preview-diagnostics">
        <li v-for="(diagnostic, index) in ready.diagnostics" :key="`${diagnostic.code}:${diagnostic.path}:${index}`" :class="`diagnostic-${diagnostic.severity}`">{{ diagnostic.message }} <code v-if="diagnostic.path">{{ diagnostic.path }}</code></li>
      </ul>
    </template>

    <template v-else-if="result?.status === 'invalid'">
      <ul class="diagnostics" data-testid="design-preview-diagnostics">
        <li v-for="(diagnostic, index) in result.diagnostics" :key="`${diagnostic.code}:${diagnostic.path}:${index}`" class="diagnostic-error">{{ diagnostic.message }} <code v-if="diagnostic.path">{{ diagnostic.path }}</code></li>
      </ul>
    </template>
    <template v-else-if="result?.status === 'conflict'">
      <p class="error" data-testid="design-preview-conflict">{{ t(`design.conflict.${result.code}`) }}</p>
      <dl class="provenance"><dt>{{ t('design.savedRevision') }}</dt><dd>{{ result.sourceProjectRevision }}</dd><dt v-if="result.currentSourceProjectRevision">{{ t('design.currentRevision') }}</dt><dd v-if="result.currentSourceProjectRevision">{{ result.currentSourceProjectRevision }}</dd></dl>
      <ul v-if="result.diagnostics.length" class="diagnostics"><li v-for="(diagnostic, index) in result.diagnostics" :key="`${diagnostic.code}:${index}`">{{ diagnostic.message }}</li></ul>
    </template>
  </section>
</template>

<style scoped>
.document-preview { border-top: 1px solid var(--border, #d9d9d9); padding: 10px 0 4px; min-width: 0; }
.preview-heading { display: flex; align-items: center; gap: 8px; }
.preview-heading strong { flex: 1; }
.status { border-radius: 10px; padding: 2px 8px; background: var(--panel, #f5f5f5); font-size: 11px; }
.status-ready { color: var(--pass, #389e0d); }
.status-invalid, .status-conflict { color: var(--fail, #cf1322); }
.status-loading { color: var(--accent); }
.provenance, .metadata-grid { display: grid; grid-template-columns: minmax(110px, auto) minmax(0, 1fr); gap: 4px 10px; font-size: 12px; }
.provenance dt, .metadata-grid dt { color: var(--text-muted); }
.provenance dd, .metadata-grid dd { margin: 0; overflow-wrap: anywhere; }
.provenance dd { font-family: ui-monospace, monospace; }
.document-api { border: 1px solid var(--border, #d9d9d9); padding: 10px; margin-top: 10px; border-radius: 4px; min-width: 0; }
.document-api > h3 { margin: 0 0 4px; }
.description { margin: 0 0 8px; }
.document-section { border-top: 1px solid var(--border, #e8e8e8); margin-top: 12px; padding-top: 8px; min-width: 0; }
.document-section h4 { margin: 0 0 8px; }
.document-section h5, .response-card h5 { margin: 8px 0 5px; }
.request-line { overflow-wrap: anywhere; }
.parameter-group { margin: 8px 0; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { border: 1px solid var(--border, #e8e8e8); text-align: left; padding: 4px 6px; vertical-align: top; }
.preserve-whitespace { white-space: pre-wrap; overflow-wrap: anywhere; }
.body-definition { margin: 10px 0; }
.definition-code { max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 5px 0; padding: 8px; background: var(--panel, #f5f5f5); font-size: 12px; }
.response-card, .model-card { border-left: 2px solid var(--border, #d9d9d9); padding: 2px 0 4px 8px; margin: 8px 0; }
.response-card h5 span { font-weight: normal; }
.response-content { margin: 8px 0; }
.response-content h6 { margin: 6px 0; }
.model-references a { margin-left: 8px; }
.documentation { white-space: pre-wrap; overflow-wrap: anywhere; }
.diagnostics { padding-left: 20px; font-size: 12px; }
.diagnostic-error, .error { color: var(--fail, #cf1322); }
</style>
