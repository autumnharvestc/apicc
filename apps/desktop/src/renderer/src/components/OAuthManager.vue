<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiRequest, SecretRef } from "@apicc/core";
import type { OAuthProfile, OAuthProfileSummary, OAuthPublicResult } from "@apicc/core/schema";
import type { ApiccApi } from "../../../shared/types.js";
import type { ProjectLocator } from "../../../shared/locations.js";
import type { OAuthAuthorizationSessionView, OAuthProfileMutationResult } from "../../../shared/oauth.js";

type ManagedState = "managed" | "unmanaged" | "unknown";
type OAuthFlow = OAuthProfile["flow"];
type OAuthClientAuthentication = OAuthProfile["clientAuthentication"];

const props = defineProps<{
  api: ApiccApi;
  locator: ProjectLocator;
  contextKey: string;
  environmentId?: string;
  auth: ApiRequest["auth"];
  readOnly?: boolean;
}>();
const emit = defineEmits<{
  "update:auth": [auth: ApiRequest["auth"]];
  "managed-state": [state: ManagedState];
}>();
const { t } = useI18n();

interface ProfileForm {
  profileId: string;
  flow: OAuthFlow;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientAuthentication: OAuthClientAuthentication;
  scope: string;
  bearerRefId: string;
  clientSecretRefId: string;
  refreshTokenRefId: string;
}

interface CapturedContext {
  epoch: number;
  token: string;
  api: ApiccApi;
  locator: ProjectLocator;
  environmentId?: string;
}

function scopedInput<T extends object>(context: CapturedContext, extra: T): {
  locator: ProjectLocator;
  environmentId?: string;
} & T {
  return {
    locator: { ...context.locator },
    ...(context.environmentId ? { environmentId: context.environmentId } : {}),
    ...extra,
  };
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function secretRef(id = randomId()): SecretRef {
  return { id, policy: "test-auto" };
}

function newForm(): ProfileForm {
  return {
    profileId: `oauth-${randomId()}`,
    flow: "client_credentials",
    authorizationEndpoint: "",
    tokenEndpoint: "",
    clientId: "",
    clientAuthentication: "client_secret_post",
    scope: "",
    bearerRefId: randomId(),
    clientSecretRefId: randomId(),
    refreshTokenRefId: randomId(),
  };
}

const profiles = ref<OAuthProfileSummary[]>([]);
const revision = ref("");
const snapshotStatus = ref<"loading" | "available" | "unavailable">("loading");
const selectedProfileId = ref("");
const form = reactive<ProfileForm>(newForm());
const clientSecretValue = ref("");
const refreshTokenValue = ref("");
const formBusy = ref(false);
const actionBusy = ref(false);
const errorMessage = ref("");
const actionResult = ref<OAuthPublicResult | null>(null);
const actionResultKind = ref<"profile" | "oauth">("oauth");
const session = ref<OAuthAuthorizationSessionView | null>(null);
const contextToken = computed(() => JSON.stringify({
  contextKey: props.contextKey,
  locator: props.locator,
  environmentId: props.environmentId ?? null,
  bearer: props.auth.kind === "bearer" ? props.auth.token : null,
}));
const selectedProfile = computed(() => profiles.value.find((item) => item.profile.profileId === selectedProfileId.value) ?? null);
const hasSelectedProfile = computed(() => selectedProfile.value !== null);
const isNewProfile = computed(() => !hasSelectedProfile.value);
const managed = computed(() => {
  const auth = props.auth;
  return auth.kind === "bearer" && profiles.value.some((item) =>
    item.profile.bearerRef.id === auth.token.id && item.profile.bearerRef.policy === auth.token.policy);
});
const managedState = computed<ManagedState>(() => snapshotStatus.value === "available"
  ? managed.value ? "managed" : "unmanaged"
  : "unknown");
const expiryText = computed(() => selectedProfile.value?.expiresAt === undefined
  ? t("oauth.expiryUnknown")
  : new Date(selectedProfile.value.expiresAt).toLocaleString());
const actionResultText = computed(() => {
  const result = actionResult.value;
  if (!result) return "";
  if (actionResultKind.value === "profile" && result.status === "success") return t("oauth.result.profileSaved");
  if (result.status === "partial_success" && result.errorCode === "OAUTH_REFRESH_TOKEN_SAVE_FAILED") {
    return t("oauth.result.refreshTokenSaveFailed");
  }
  if (result.status === "partial_success" && result.errorCode === "OAUTH_ACCESS_TOKEN_SAVE_FAILED") {
    return t("oauth.result.accessTokenSaveFailed");
  }
  if (result.status === "reauthorization_required") return t("oauth.result.reauthorizationRequired");
  if (result.status === "failed") return t("oauth.result.failed", { code: result.errorCode ?? "" });
  if (result.status === "partial_success") return t("oauth.result.partial");
  return result.expiresAt === undefined
    ? t("oauth.result.successExpiryUnknown")
    : t("oauth.result.success", { expiry: new Date(result.expiresAt).toLocaleString() });
});
const sessionStatusText = computed(() => session.value ? t(`oauth.session.${session.value.status}`) : "");

let contextEpoch = 0;
let profileSelectionEpoch = 0;
let componentAlive = true;
let activeSessionApi: ApiccApi | null = null;

function captureContext(): CapturedContext {
  return {
    epoch: contextEpoch,
    token: contextToken.value,
    api: props.api,
    locator: { ...props.locator },
    ...(props.environmentId ? { environmentId: props.environmentId } : {}),
  };
}

function isCurrent(context: CapturedContext): boolean {
  return componentAlive && context.epoch === contextEpoch && context.token === contextToken.value && context.api === props.api;
}

function isCurrentOperation(context: CapturedContext, selectionEpoch: number, selectedId: string): boolean {
  return isCurrent(context)
    && selectionEpoch === profileSelectionEpoch
    && selectedProfileId.value === selectedId;
}

function cancelPendingSession(pending: OAuthAuthorizationSessionView | null, api: ApiccApi | null): void {
  if (!pending || pending.status !== "pending" || !api) return;
  void api.oauthAuthorizeCancel({ sessionId: pending.sessionId }).catch(() => undefined);
}

function profileFormFrom(profile: OAuthProfile): void {
  form.profileId = profile.profileId;
  form.flow = profile.flow;
  form.authorizationEndpoint = profile.authorizationEndpoint ?? "";
  form.tokenEndpoint = profile.tokenEndpoint;
  form.clientId = profile.clientId;
  form.clientAuthentication = profile.clientAuthentication;
  form.scope = profile.scope ?? "";
  form.bearerRefId = profile.bearerRef.id;
  form.clientSecretRefId = profile.clientSecretRef?.id ?? randomId();
  form.refreshTokenRefId = profile.refreshTokenRef?.id ?? randomId();
  clientSecretValue.value = "";
  refreshTokenValue.value = "";
}

function selectProfile(profileId: string): void {
  cancelPendingSession(session.value, activeSessionApi);
  profileSelectionEpoch += 1;
  formBusy.value = false;
  actionBusy.value = false;
  selectedProfileId.value = profileId;
  errorMessage.value = "";
  actionResult.value = null;
  session.value = null;
  activeSessionApi = null;
  if (!profileId) {
    Object.assign(form, newForm());
    clientSecretValue.value = "";
    refreshTokenValue.value = "";
    return;
  }
  const found = profiles.value.find((item) => item.profile.profileId === profileId);
  if (found) profileFormFrom(found.profile);
}

function selectInitialProfile(): void {
  const bearer = props.auth.kind === "bearer" ? props.auth.token : null;
  const linked = bearer && profiles.value.find((item) => item.profile.bearerRef.id === bearer.id && item.profile.bearerRef.policy === bearer.policy);
  const next = linked ?? profiles.value[0];
  selectProfile(next?.profile.profileId ?? "");
}

function applyProfileSnapshot(nextRevision: string, nextProfiles: OAuthProfileSummary[]): void {
  profiles.value = nextProfiles.map((item) => ({ ...item, profile: { ...item.profile } }));
  revision.value = nextRevision;
  snapshotStatus.value = "available";
  if (selectedProfileId.value && profiles.value.some((item) => item.profile.profileId === selectedProfileId.value)) return;
  selectInitialProfile();
}

async function loadProfiles(context = captureContext()): Promise<void> {
  if (!isCurrent(context)) return;
  snapshotStatus.value = "loading";
  try {
    const result = await context.api.oauthProfilesGet(scopedInput(context, {}));
    if (!isCurrent(context)) return;
    applyProfileSnapshot(result.revision, result.profiles);
  } catch {
    if (isCurrent(context)) snapshotStatus.value = "unavailable";
  }
}

function applyMutationResult(result: OAuthProfileMutationResult, kind: "profile" | "oauth" = "oauth"): void {
  actionResult.value = result.result;
  actionResultKind.value = kind;
  if (result.profileSnapshot.status === "available") {
    applyProfileSnapshot(result.profileSnapshot.revision, result.profileSnapshot.profiles);
  } else {
    snapshotStatus.value = "unavailable";
  }
}

async function saveProfile(): Promise<void> {
  const context = captureContext();
  const selectionEpoch = profileSelectionEpoch;
  const selectedId = selectedProfileId.value;
  if (props.readOnly || formBusy.value || snapshotStatus.value !== "available") return;
  const profileId = form.profileId.trim();
  const tokenEndpoint = form.tokenEndpoint.trim();
  const clientId = form.clientId.trim();
  if (!profileId || !tokenEndpoint || !clientId || (form.flow === "authorization_code" && !form.authorizationEndpoint.trim())) {
    errorMessage.value = t("oauth.result.requiredFields");
    return;
  }
  if (form.flow === "client_credentials" && form.clientAuthentication === "none") {
    errorMessage.value = t("oauth.result.clientSecretRequired");
    return;
  }
  if (isNewProfile.value && form.clientAuthentication !== "none" && !clientSecretValue.value) {
    errorMessage.value = t("oauth.result.clientSecretRequired");
    return;
  }
  if (isNewProfile.value && form.flow === "refresh_token" && !refreshTokenValue.value) {
    errorMessage.value = t("oauth.result.refreshTokenRequired");
    return;
  }
  const bearerRef = selectedProfile.value?.profile.bearerRef ?? secretRef(form.bearerRefId);
  const clientSecretRef = form.clientAuthentication === "none"
    ? undefined
    : clientSecretValue.value && selectedProfile.value?.profile.clientSecretRef?.id === form.clientSecretRefId
      ? secretRef()
      : selectedProfile.value?.profile.clientSecretRef?.id === form.clientSecretRefId
        ? selectedProfile.value.profile.clientSecretRef
        : secretRef(form.clientSecretRefId);
  const refreshTokenRef = form.flow === "client_credentials"
    ? undefined
    : refreshTokenValue.value && selectedProfile.value?.profile.refreshTokenRef?.id === form.refreshTokenRefId
      ? secretRef()
      : selectedProfile.value?.profile.refreshTokenRef?.id === form.refreshTokenRefId
        ? selectedProfile.value.profile.refreshTokenRef
        : secretRef(form.refreshTokenRefId);
  if (clientSecretRef) form.clientSecretRefId = clientSecretRef.id;
  if (refreshTokenRef) form.refreshTokenRefId = refreshTokenRef.id;
  const profile: OAuthProfile = {
    profileId,
    flow: form.flow,
    tokenEndpoint,
    clientId,
    clientAuthentication: form.clientAuthentication,
    bearerRef,
    ...(context.environmentId ? { environmentId: context.environmentId } : {}),
    ...(form.scope.trim() ? { scope: form.scope.trim() } : {}),
    ...(form.flow === "authorization_code" ? { authorizationEndpoint: form.authorizationEndpoint.trim() } : {}),
    ...(clientSecretRef ? { clientSecretRef } : {}),
    ...(refreshTokenRef ? { refreshTokenRef } : {}),
  };

  formBusy.value = true;
  errorMessage.value = "";
  actionResult.value = null;
  let secretSaved = false;
  try {
    for (const [secretRefValue, secretValue, clearValue] of [
      [clientSecretRef, clientSecretValue.value, () => { clientSecretValue.value = ""; }],
      [refreshTokenRef, refreshTokenValue.value, () => { refreshTokenValue.value = ""; }],
    ] as const) {
      if (!secretRefValue || !secretValue) continue;
      const stored = await context.api.credentialPut({ locator: context.locator, ref: secretRefValue, value: secretValue });
      if (!isCurrentOperation(context, selectionEpoch, selectedId)) return;
      if (!stored.ok) {
        errorMessage.value = stored.error.message;
        return;
      }
      secretSaved = true;
      clearValue();
    }
    const saved = await context.api.oauthProfileSave(scopedInput(context, {
      profile,
      ...(revision.value ? { expectedRevision: revision.value } : {}),
    }));
    if (!isCurrentOperation(context, selectionEpoch, selectedId)) return;
    applyMutationResult(saved, "profile");
    if (saved.result.status === "success" || saved.result.status === "partial_success") {
      emit("update:auth", { kind: "bearer", token: { ...profile.bearerRef } });
    } else if (saved.result.status === "failed") {
      errorMessage.value = secretSaved ? t("oauth.result.secretSavedProfileFailed") : t("oauth.result.failed", { code: saved.result.errorCode ?? "" });
    }
  } catch {
    if (isCurrentOperation(context, selectionEpoch, selectedId)) errorMessage.value = secretSaved ? t("oauth.result.secretSavedProfileFailed") : t("oauth.result.operationFailed");
  } finally {
    if (isCurrentOperation(context, selectionEpoch, selectedId)) formBusy.value = false;
  }
}

async function runProfileAction(action: "acquire" | "refresh" | "unlink"): Promise<void> {
  const context = captureContext();
  const profileId = selectedProfile.value?.profile.profileId;
  const selectionEpoch = profileSelectionEpoch;
  if (!profileId || props.readOnly || actionBusy.value || snapshotStatus.value !== "available") return;
  actionBusy.value = true;
  errorMessage.value = "";
  try {
    const input = scopedInput(context, {
      profileId,
      ...(action === "unlink" && revision.value ? { expectedRevision: revision.value } : {}),
    });
    const result = action === "acquire"
      ? await context.api.oauthProfileAcquire(input)
      : action === "refresh"
        ? await context.api.oauthProfileRefresh(input)
        : await context.api.oauthProfileUnlink(input);
    if (!isCurrentOperation(context, selectionEpoch, profileId)) return;
    applyMutationResult(result);
  } catch {
    if (isCurrentOperation(context, selectionEpoch, profileId)) errorMessage.value = t("oauth.result.operationFailed");
  } finally {
    if (isCurrentOperation(context, selectionEpoch, profileId)) actionBusy.value = false;
  }
}

async function waitForAuthorization(context: CapturedContext, selectionEpoch: number, profileId: string, sessionId: string): Promise<void> {
  try {
    const completed = await context.api.oauthAuthorizeWait({ sessionId });
    if (!isCurrentOperation(context, selectionEpoch, profileId) || !completed || session.value?.sessionId !== sessionId || session.value.status !== "pending") return;
    session.value = completed;
    if (completed.operationResult) actionResult.value = completed.operationResult;
    if (completed.status === "success") await loadProfiles(context);
  } catch {
    if (isCurrentOperation(context, selectionEpoch, profileId) && session.value?.sessionId === sessionId && session.value.status === "pending") {
      errorMessage.value = t("oauth.result.operationFailed");
    }
  }
}

async function beginAuthorization(): Promise<void> {
  const context = captureContext();
  const profileId = selectedProfile.value?.profile.profileId;
  const selectionEpoch = profileSelectionEpoch;
  if (!profileId || props.readOnly || actionBusy.value || selectedProfile.value?.profile.flow !== "authorization_code") return;
  actionBusy.value = true;
  errorMessage.value = "";
  try {
    const started = await context.api.oauthAuthorizeBegin(scopedInput(context, { profileId }));
    if (!isCurrentOperation(context, selectionEpoch, profileId)) {
      cancelPendingSession(started, context.api);
      return;
    }
    session.value = started;
    activeSessionApi = context.api;
    if (started.operationResult) actionResult.value = started.operationResult;
    if (started.status === "pending") void waitForAuthorization(context, selectionEpoch, profileId, started.sessionId);
    else if (started.status === "success") await loadProfiles(context);
  } catch {
    if (isCurrentOperation(context, selectionEpoch, profileId)) errorMessage.value = t("oauth.result.operationFailed");
  } finally {
    if (isCurrentOperation(context, selectionEpoch, profileId)) actionBusy.value = false;
  }
}

async function cancelAuthorization(): Promise<void> {
  const context = captureContext();
  const pending = session.value;
  const selectionEpoch = profileSelectionEpoch;
  if (!pending || pending.status !== "pending" || actionBusy.value) return;
  actionBusy.value = true;
  try {
    const completed = await context.api.oauthAuthorizeCancel({ sessionId: pending.sessionId });
    if (!isCurrentOperation(context, selectionEpoch, pending.profileId) || session.value?.sessionId !== pending.sessionId) return;
    if (completed) session.value = completed;
  } catch {
    if (isCurrentOperation(context, selectionEpoch, pending.profileId)) errorMessage.value = t("oauth.result.operationFailed");
  } finally {
    if (isCurrentOperation(context, selectionEpoch, pending.profileId)) actionBusy.value = false;
  }
}

async function cancelForPreviousContext(): Promise<void> {
  cancelPendingSession(session.value, activeSessionApi);
}

watch(contextToken, () => {
  void cancelForPreviousContext();
  contextEpoch += 1;
  profileSelectionEpoch += 1;
  profiles.value = [];
  revision.value = "";
  snapshotStatus.value = "loading";
  selectedProfileId.value = "";
  Object.assign(form, newForm());
  clientSecretValue.value = "";
  refreshTokenValue.value = "";
  formBusy.value = false;
  actionBusy.value = false;
  actionResult.value = null;
  session.value = null;
  activeSessionApi = null;
  errorMessage.value = "";
  void loadProfiles(captureContext());
}, { immediate: true });

watch(managedState, (state) => emit("managed-state", state), { immediate: true });
watch(() => [props.auth, profiles.value, snapshotStatus.value] as const, () => emit("managed-state", managedState.value), { deep: true });

onBeforeUnmount(() => {
  void cancelForPreviousContext();
  componentAlive = false;
  contextEpoch += 1;
  profileSelectionEpoch += 1;
  session.value = null;
  activeSessionApi = null;
});
</script>

<template>
  <section class="oauth-manager" data-testid="oauth-manager">
    <header class="oauth-heading">
      <div>
        <h3>{{ t("oauth.title") }}</h3>
        <p>{{ t("oauth.note") }}</p>
      </div>
      <button type="button" data-testid="oauth-reload" :disabled="snapshotStatus === 'loading'" @click="loadProfiles()">{{ t("oauth.reload") }}</button>
    </header>
    <p role="status" data-testid="oauth-snapshot-status">{{ t(`oauth.snapshot.${snapshotStatus}`) }}</p>
    <label>
      {{ t("oauth.profile") }}
      <select data-testid="oauth-profile-select" :value="selectedProfileId" @change="selectProfile(($event.target as HTMLSelectElement).value)">
        <option value="">{{ t("oauth.newProfile") }}</option>
        <option v-for="item in profiles" :key="item.profile.profileId" :value="item.profile.profileId">{{ item.profile.profileId }}</option>
      </select>
    </label>

    <template v-if="selectedProfile">
      <p role="status" data-testid="oauth-profile-status">{{ t(`oauth.status.${selectedProfile.status}`) }}</p>
      <p data-testid="oauth-profile-expiry">{{ t("oauth.expiresAt", { expiry: expiryText }) }}</p>
    </template>
    <p v-else-if="snapshotStatus === 'available'" data-testid="oauth-no-profiles">{{ t("oauth.noProfiles") }}</p>

    <form class="oauth-form" data-testid="oauth-profile-form" @submit.prevent="saveProfile">
      <label>{{ t("oauth.profileId") }}<input v-model="form.profileId" data-testid="oauth-profile-id" :disabled="props.readOnly || formBusy || hasSelectedProfile" autocomplete="off" /></label>
      <label>
        {{ t("oauth.flow") }}
        <select v-model="form.flow" data-testid="oauth-flow" :disabled="props.readOnly || formBusy">
          <option value="client_credentials">{{ t("oauth.flowClientCredentials") }}</option>
          <option value="authorization_code">{{ t("oauth.flowAuthorizationCode") }}</option>
          <option value="refresh_token">{{ t("oauth.flowRefreshToken") }}</option>
        </select>
      </label>
      <label v-if="form.flow === 'authorization_code'">{{ t("oauth.authorizationEndpoint") }}<input v-model="form.authorizationEndpoint" data-testid="oauth-authorization-endpoint" autocomplete="url" :disabled="props.readOnly || formBusy" /></label>
      <label>{{ t("oauth.tokenEndpoint") }}<input v-model="form.tokenEndpoint" data-testid="oauth-token-endpoint" autocomplete="url" :disabled="props.readOnly || formBusy" /></label>
      <label>{{ t("oauth.clientId") }}<input v-model="form.clientId" data-testid="oauth-client-id" autocomplete="off" :disabled="props.readOnly || formBusy" /></label>
      <label>
        {{ t("oauth.clientAuthentication") }}
        <select v-model="form.clientAuthentication" data-testid="oauth-client-authentication" :disabled="props.readOnly || formBusy">
          <option value="none">{{ t("oauth.clientAuthenticationNone") }}</option>
          <option value="client_secret_basic">{{ t("oauth.clientAuthenticationBasic") }}</option>
          <option value="client_secret_post">{{ t("oauth.clientAuthenticationPost") }}</option>
        </select>
      </label>
      <label v-if="form.clientAuthentication !== 'none'">{{ t("oauth.clientSecret") }}<input v-model="clientSecretValue" type="password" autocomplete="new-password" data-testid="oauth-client-secret" :disabled="props.readOnly || formBusy" /></label>
      <label v-if="form.flow !== 'client_credentials'">{{ t("oauth.initialRefreshToken") }}<input v-model="refreshTokenValue" type="password" autocomplete="new-password" data-testid="oauth-refresh-token" :disabled="props.readOnly || formBusy" /></label>
      <label>{{ t("oauth.scope") }}<input v-model="form.scope" data-testid="oauth-scope" autocomplete="off" :disabled="props.readOnly || formBusy" /></label>
      <p class="oauth-refs" data-testid="oauth-refs">
        {{ t("oauth.bearerReference", { ref: form.bearerRefId }) }}
        <span v-if="form.clientAuthentication !== 'none'"> · {{ t("oauth.clientSecretReference", { ref: form.clientSecretRefId }) }}</span>
        <span v-if="form.flow !== 'client_credentials'"> · {{ t("oauth.refreshTokenReference", { ref: form.refreshTokenRefId }) }}</span>
      </p>
      <button type="submit" data-testid="oauth-save" :disabled="props.readOnly || formBusy || snapshotStatus !== 'available'">{{ t("oauth.saveProfile") }}</button>
    </form>

    <div class="oauth-actions">
      <button v-if="selectedProfile?.profile.flow === 'client_credentials'" type="button" data-testid="oauth-acquire" :disabled="props.readOnly || actionBusy || snapshotStatus !== 'available'" @click="runProfileAction('acquire')">{{ t("oauth.getToken") }}</button>
      <button v-if="selectedProfile?.profile.flow === 'authorization_code'" type="button" data-testid="oauth-authorize" :disabled="props.readOnly || actionBusy" @click="beginAuthorization">{{ t("oauth.authorize") }}</button>
      <button v-if="selectedProfile?.profile.refreshTokenRef" type="button" data-testid="oauth-refresh" :disabled="props.readOnly || actionBusy || snapshotStatus !== 'available'" @click="runProfileAction('refresh')">{{ t("oauth.refresh") }}</button>
      <button v-if="selectedProfile" type="button" data-testid="oauth-unlink" :disabled="props.readOnly || actionBusy || snapshotStatus !== 'available'" @click="runProfileAction('unlink')">{{ t("oauth.unlink") }}</button>
      <button v-if="session?.status === 'pending'" type="button" data-testid="oauth-cancel" :disabled="actionBusy" @click="cancelAuthorization">{{ t("oauth.cancel") }}</button>
    </div>
    <p v-if="session" role="status" data-testid="oauth-session-status">{{ sessionStatusText }}</p>
    <p v-if="actionResult" role="status" data-testid="oauth-action-result">{{ actionResultText }}</p>
    <p v-if="errorMessage" role="alert" data-testid="oauth-error">{{ errorMessage }}</p>
  </section>
</template>

<style scoped>
.oauth-manager { display: grid; gap: 8px; margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; }
.oauth-heading, .oauth-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.oauth-heading h3, .oauth-heading p { margin: 0; }
.oauth-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; align-items: end; }
.oauth-form label, .oauth-manager > label { display: grid; gap: 4px; }
.oauth-refs { grid-column: 1 / -1; margin: 0; color: var(--text-muted); overflow-wrap: anywhere; }
.oauth-form button { justify-self: start; }
</style>
