<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiRequest, SecretRef } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { ProjectLocator } from "../../../shared/locations.js";

const props = defineProps<{
  api: ApiccApi;
  locator: ProjectLocator;
  auth: ApiRequest["auth"];
  contextKey?: string;
  managedState?: "managed" | "unmanaged" | "unknown";
  readOnly?: boolean;
}>();
const { t } = useI18n();
const value = ref("");
const status = ref("");
const error = ref("");
const saving = ref(false);
const mutationFeedback = ref<"" | "saved" | "removed">("");
let contextEpoch = 0;
const credentialDisabled = computed(() => props.readOnly || saving.value || props.managedState === "managed" || props.managedState === "unknown");

const refValue = computed<SecretRef | null>(() => {
  const auth = props.auth;
  if (auth.kind === "bearer") return auth.token;
  if (auth.kind === "basic") return auth.password;
  if (auth.kind === "apikey") return auth.value;
  return null;
});
const contextToken = computed(() => JSON.stringify({
  contextKey: props.contextKey ?? "",
  locator: props.locator,
  ref: refValue.value,
}));

interface CapturedContext {
  epoch: number;
  token: string;
  api: ApiccApi;
  locator: ProjectLocator;
  ref: SecretRef | null;
}

function captureContext(): CapturedContext {
  return {
    epoch: contextEpoch,
    token: contextToken.value,
    api: props.api,
    locator: { ...props.locator },
    ref: refValue.value ? { ...refValue.value } : null,
  };
}

function isCurrent(context: CapturedContext): boolean {
  return context.epoch === contextEpoch && context.token === contextToken.value && context.api === props.api;
}

async function refreshStatus(context: CapturedContext) {
  if (!isCurrent(context)) return;
  status.value = "";
  if (!context.ref) return;
  try {
    const result = await context.api.credentialStatus({ locator: context.locator, ref: context.ref });
    if (!isCurrent(context)) return;
    if (result.ok) status.value = result.status;
    else error.value = result.error.message;
  } catch (cause) {
    if (isCurrent(context)) error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

watch([contextToken, () => props.api], () => {
  contextEpoch += 1;
  value.value = "";
  error.value = "";
  status.value = "";
  saving.value = false;
  mutationFeedback.value = "";
  void refreshStatus(captureContext());
}, { immediate: true });

async function saveCredential() {
  const context = captureContext();
  const submittedValue = value.value;
  if (!context.ref || !submittedValue || credentialDisabled.value) return;
  saving.value = true;
  error.value = "";
  mutationFeedback.value = "";
  try {
    const result = await context.api.credentialPut({ locator: context.locator, ref: context.ref, value: submittedValue });
    if (!isCurrent(context)) return;
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    mutationFeedback.value = "saved";
    value.value = "";
    await refreshStatus(context);
  } catch (cause) {
    if (isCurrent(context)) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (isCurrent(context)) saving.value = false;
  }
}

async function removeCredential() {
  const context = captureContext();
  if (!context.ref || credentialDisabled.value) return;
  saving.value = true;
  error.value = "";
  mutationFeedback.value = "";
  try {
    const result = await context.api.credentialRemove({ locator: context.locator, ref: context.ref });
    if (!isCurrent(context)) return;
    if (!result.ok) error.value = result.error.message;
    else {
      mutationFeedback.value = "removed";
      await refreshStatus(context);
    }
  } catch (cause) {
    if (isCurrent(context)) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (isCurrent(context)) saving.value = false;
  }
}
</script>

<template>
  <section class="credentials" data-testid="credential-editor">
    <template v-if="refValue">
      <p class="credential-warning" role="note" data-testid="credential-warning">{{ t('contract.credentialWarning') }}</p>
      <p v-if="managedState === 'managed'" role="note" data-testid="credential-oauth-managed">{{ t('contract.credentialOAuthManaged') }}</p>
      <p v-else-if="managedState === 'unknown'" role="status" data-testid="credential-oauth-unknown">{{ t('contract.credentialOAuthUnknown') }}</p>
      <label>{{ t('contract.credentialValue') }}<input v-model="value" type="password" autocomplete="new-password" data-testid="credential-value" :disabled="credentialDisabled" /></label>
      <button type="button" data-testid="credential-save" :disabled="credentialDisabled || !value" @click="saveCredential">{{ t('contract.credentialSave') }}</button>
      <button type="button" data-testid="credential-remove" :disabled="credentialDisabled" @click="removeCredential">{{ t('contract.credentialRemove') }}</button>
      <p class="credential-remove-impact" role="note" data-testid="credential-remove-impact">{{ t('contract.credentialRemoveImpact') }}</p>
      <span v-if="mutationFeedback === 'saved'" data-testid="credential-saved">{{ t('contract.credentialSaved') }}</span>
      <span v-else-if="mutationFeedback === 'removed'" data-testid="credential-removed">{{ t('contract.credentialRemoved') }}</span>
      <span v-if="status" data-testid="credential-status">{{ t(`contract.credentialStatus.${status}`) }}</span>
      <span v-if="error" data-testid="credential-error">{{ error }}</span>
    </template>
    <span v-else>{{ t('contract.credentialSelectAuth') }}</span>
  </section>
</template>

<style scoped>
.credentials { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.credential-warning { flex-basis: 100%; margin: 0; padding: 8px 10px; border: 1px solid #d89614; background: #fffbe6; color: #614700; font-weight: 600; }
label { display: flex; gap: 6px; align-items: center; }
</style>
