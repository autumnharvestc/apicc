<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NetworkConfigurationSchema, NetworkProfileSchema, type NetworkConfiguration, type SecretRef } from "@apicc/core/schema";
import type { ApiccApi } from "../../../shared/types.js";
import type { ProjectLocator } from "../../../shared/locations.js";
import type { NetworkProfilesResult } from "../../../shared/network.js";

const props = defineProps<{
  api: ApiccApi;
  locator: ProjectLocator;
  readOnly: boolean;
}>();
const { t, locale } = useI18n();

const loaded = ref<NetworkProfilesResult>();
const profilesText = ref("[]");
const scopeId = ref("");
const selectionValue = ref("direct");
const selectedProfileId = ref("");
const secretRefId = ref("");
const loading = ref(false);
const saving = ref(false);
const importing = ref(false);
const savingFormSecret = ref(false);
const configurationMessage = ref("");
const secretMessage = ref("");
const formSecretMessage = ref("");
const profileMessage = ref("");

const profileForm = reactive({
  name: "",
  kind: "proxy" as "direct" | "proxy",
  proxyUrl: "http://127.0.0.1:8080",
  username: "",
  passwordRefId: "",
  password: "",
  targetOrigin: "",
  caCertificatePaths: "",
  clientCertificatePaths: "",
  clientPrivateKeyRefId: "",
  clientKeyPassphraseRefId: "",
  clientKeyPassphrase: "",
  targetVerify: true,
});

const profiles = computed(() => {
  try {
    const value: unknown = JSON.parse(profilesText.value);
    return Array.isArray(value) ? value.filter((item): item is { id: string; name: string; kind?: string; targetTlsBindings?: unknown[]; proxyTLS?: { verify?: boolean } } =>
      typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string" && typeof (item as { name?: unknown }).name === "string") : [];
  } catch {
    return [];
  }
});

const verificationWarning = computed(() => {
  try {
    const value = JSON.parse(profilesText.value) as Array<{ proxyTLS?: { verify?: boolean }; targetTlsBindings?: Array<{ tls?: { verify?: boolean } }> }>;
    return value.some((profile) => profile.proxyTLS?.verify === false
      || profile.targetTlsBindings?.some((binding) => binding.tls?.verify === false));
  } catch {
    return false;
  }
});

const secretStatuses = computed(() => loaded.value?.secretStatuses ?? []);

function createSecretRef(id: string): SecretRef {
  return { id: id.trim(), policy: "test-auto" };
}

function pathLines(value: string): string[] {
  return value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
}

async function saveFormSecret(refId: string, value: string, field: "password" | "passphrase"): Promise<void> {
  const id = refId.trim();
  if (!id || !value || props.readOnly || savingFormSecret.value) {
    formSecretMessage.value = t("networkSettings.secretNeedsRefAndValue");
    return;
  }
  savingFormSecret.value = true;
  formSecretMessage.value = "";
  try {
    const ref = createSecretRef(id);
    const result = await props.api.credentialPut({ locator: props.locator, ref, value });
    if (!result.ok) {
      formSecretMessage.value = result.error.message;
      return;
    }
    if (field === "password") profileForm.password = "";
    else profileForm.clientKeyPassphrase = "";
    formSecretMessage.value = t("networkSettings.secretSaved");
  } catch {
    formSecretMessage.value = t("networkSettings.secretSaveFailed");
  } finally {
    savingFormSecret.value = false;
  }
}

function addProfileFromForm(): void {
  profileMessage.value = "";
  try {
    const currentProfiles: unknown = JSON.parse(profilesText.value);
    if (!Array.isArray(currentProfiles)) throw new Error(t("networkSettings.profilesMustBeArray"));
    const origin = profileForm.targetOrigin.trim();
    const caCertificatePaths = pathLines(profileForm.caCertificatePaths);
    const clientCertificatePaths = pathLines(profileForm.clientCertificatePaths);
    const clientPrivateKeyRefId = profileForm.clientPrivateKeyRefId.trim();
    const clientKeyPassphraseRefId = profileForm.clientKeyPassphraseRefId.trim();
    const hasTargetTls = Boolean(origin || caCertificatePaths.length || clientCertificatePaths.length || clientPrivateKeyRefId || clientKeyPassphraseRefId);
    if (hasTargetTls && !origin) throw new Error(t("networkSettings.targetOriginRequired"));
    const targetTlsBindings = hasTargetTls ? [{
      origin,
      tls: {
        verify: profileForm.targetVerify,
        ...(caCertificatePaths.length ? { caCertificatePaths } : {}),
        ...(clientCertificatePaths.length ? { clientCertificatePaths } : {}),
        ...(clientPrivateKeyRefId ? { clientPrivateKeyRef: createSecretRef(clientPrivateKeyRefId) } : {}),
        ...(clientKeyPassphraseRefId ? { clientKeyPassphraseRef: createSecretRef(clientKeyPassphraseRefId) } : {}),
      },
    }] : [];
    const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const baseProfile = {
      id: `network-${randomId}`,
      name: profileForm.name.trim(),
      targetTlsBindings,
    };
    const rawProfile = profileForm.kind === "direct"
      ? { ...baseProfile, kind: "direct" }
      : {
        ...baseProfile,
        kind: "proxy",
        proxyUrl: profileForm.proxyUrl.trim(),
        ...(profileForm.username.trim() ? { username: profileForm.username.trim() } : {}),
        ...(profileForm.passwordRefId.trim() ? { passwordRef: createSecretRef(profileForm.passwordRefId) } : {}),
      };
    const profile = NetworkProfileSchema.parse(rawProfile);
    const configuration: NetworkConfiguration = NetworkConfigurationSchema.parse({
      ...(loaded.value?.configuration ?? { formatVersion: 1, environmentSelections: [] }),
      profiles: [...currentProfiles, profile],
    });
    profilesText.value = JSON.stringify(configuration.profiles, null, 2);
    selectedProfileId.value = profile.id;
    selectionValue.value = "profile";
    profileMessage.value = t("networkSettings.profileAdded");
  } catch (error) {
    profileMessage.value = error instanceof Error ? error.message : t("networkSettings.profileCouldNotBeAdded");
  }
}

function usePrivateKeyRefForImport(): void {
  secretRefId.value = profileForm.clientPrivateKeyRefId.trim();
}

function selectedNetworkSelection(): { kind: "direct" } | { kind: "profile"; profileId: string } | undefined {
  if (selectionValue.value === "inherit") return undefined;
  if (selectionValue.value === "profile") {
    return selectedProfileId.value ? { kind: "profile", profileId: selectedProfileId.value } : undefined;
  }
  return { kind: "direct" };
}

function syncSelection(configuration: NetworkConfiguration, targetScope: string): void {
  const selection = targetScope
    ? configuration.environmentSelections.find((entry) => entry.environmentId === targetScope)?.selection
    : configuration.projectSelection;
  if (targetScope && !selection) {
    selectionValue.value = "inherit";
    selectedProfileId.value = "";
  } else if (selection?.kind === "profile") {
    selectionValue.value = "profile";
    selectedProfileId.value = selection.profileId;
  } else {
    selectionValue.value = "direct";
    selectedProfileId.value = "";
  }
}

function isSameLocator(left: ProjectLocator, right: ProjectLocator): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await props.api.networkProfilesGet(props.locator);
    loaded.value = result;
    profilesText.value = JSON.stringify(result.configuration.profiles, null, 2);
    syncSelection(result.configuration, scopeId.value);
    configurationMessage.value = t("networkSettings.configurationLoaded");
  } catch (error) {
    configurationMessage.value = error instanceof Error ? error.message : t("networkSettings.configurationLoadFailed");
  } finally {
    loading.value = false;
  }
}

async function saveConfiguration(): Promise<void> {
  if (!loaded.value || props.readOnly) return;
  const loadedAtStart = loaded.value;
  const locator = { ...props.locator };
  const isCurrentSave = (revision: string) => isSameLocator(props.locator, locator) && loaded.value?.revision === revision;
  saving.value = true;
  configurationMessage.value = "";
  try {
    const profilesValue: unknown = JSON.parse(profilesText.value);
    if (!Array.isArray(profilesValue)) throw new Error(t("networkSettings.profilesMustBeArray"));
    const candidate = {
      ...loaded.value.configuration,
      profiles: profilesValue,
      ...(scopeId.value ? {} : { projectSelection: selectedNetworkSelection() ?? { kind: "direct" } }),
      environmentSelections: scopeId.value
        ? [
          ...loaded.value.configuration.environmentSelections.filter((entry) => entry.environmentId !== scopeId.value),
          ...(selectedNetworkSelection() ? [{ environmentId: scopeId.value, selection: selectedNetworkSelection()! }] : []),
        ]
        : loaded.value.configuration.environmentSelections,
    };
    const configuration: NetworkConfiguration = NetworkConfigurationSchema.parse(candidate);
    const result = await props.api.networkProfilesSave({ locator, revision: loadedAtStart.revision, configuration });
    if (!isCurrentSave(loadedAtStart.revision)) return;
    const saved: NetworkProfilesResult = { ...loadedAtStart, revision: result.revision, configuration };
    loaded.value = saved;
    configurationMessage.value = t("networkSettings.configurationSaved");
    try {
      const refreshed = await props.api.networkProfilesGet(locator);
      if (isCurrentSave(saved.revision)) loaded.value = { ...saved, secretStatuses: refreshed.secretStatuses };
    } catch {
      if (isCurrentSave(saved.revision)) configurationMessage.value = t("networkSettings.configurationSavedStatusRefreshFailed");
    }
  } catch (error) {
    configurationMessage.value = error instanceof Error ? error.message : t("networkSettings.configurationSaveFailed");
  } finally {
    saving.value = false;
  }
}

async function importSecret(): Promise<void> {
  if (!secretRefId.value.trim() || props.readOnly) return;
  const locator = { ...props.locator };
  const isCurrentImport = () => isSameLocator(props.locator, locator);
  importing.value = true;
  secretMessage.value = "";
  try {
    const result = await props.api.networkSecretImport({ locator, ref: { id: secretRefId.value.trim(), policy: "test-auto" }, locale: locale.value === "zh-CN" ? "zh-CN" : "en" });
    if (!isCurrentImport()) return;
    secretMessage.value = result.outcome === "saved"
      ? t("networkSettings.secretSaved")
      : result.outcome === "cancelled" ? t("networkSettings.secretImportCancelled") : result.message;
    if (result.outcome === "saved") {
      try {
        const refreshed = await props.api.networkProfilesGet(locator);
        if (isCurrentImport() && loaded.value) loaded.value = { ...loaded.value, secretStatuses: refreshed.secretStatuses };
      } catch {
        if (isCurrentImport()) secretMessage.value = t("networkSettings.secretSavedStatusRefreshFailed");
      }
    }
  } catch {
    if (isCurrentImport()) secretMessage.value = t("networkSettings.secretImportFailed");
  } finally {
    importing.value = false;
  }
}

watch(scopeId, (value) => {
  if (loaded.value) syncSelection(loaded.value.configuration, value);
});
watch(() => [props.locator.workspaceId, props.locator.groupId, props.locator.projectId].join("/"), () => {
  loaded.value = undefined;
  scopeId.value = "";
  void load();
});
onMounted(() => { void load(); });
</script>

<template>
  <section class="network-settings" data-testid="network-settings">
    <h3>{{ t("networkSettings.title") }}</h3>
    <p class="note">{{ t("networkSettings.note") }}</p>
    <label>
      {{ t("networkSettings.applyTo") }}
      <select v-model="scopeId" data-testid="network-scope">
        <option value="">{{ t("networkSettings.projectDefault") }}</option>
        <option v-for="environment in loaded?.environments ?? []" :key="environment.id" :value="environment.id">{{ t("networkSettings.environmentOption", { name: environment.name }) }}</option>
      </select>
    </label>
    <label>
      {{ t("networkSettings.selection") }}
      <select v-model="selectionValue" data-testid="network-selection">
        <option v-if="scopeId" value="inherit">{{ t("networkSettings.inherit") }}</option>
        <option value="direct">{{ t("networkSettings.direct") }}</option>
        <option value="profile">{{ t("networkSettings.useProfile") }}</option>
      </select>
    </label>
    <label v-if="selectionValue === 'profile'">
      {{ t("networkSettings.profile") }}
      <select v-model="selectedProfileId" data-testid="network-profile-select">
        <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }} ({{ profile.kind ?? t("networkSettings.profile") }})</option>
      </select>
    </label>
    <fieldset class="profile-form">
      <legend>{{ t("networkSettings.profileFormTitle") }}</legend>
      <label>
        {{ t("networkSettings.profileName") }}
        <input v-model="profileForm.name" autocomplete="off" data-testid="network-profile-name" />
      </label>
      <label>
        {{ t("networkSettings.profileKind") }}
        <select v-model="profileForm.kind" data-testid="network-profile-kind">
          <option value="direct">{{ t("networkSettings.directKind") }}</option>
          <option value="proxy">{{ t("networkSettings.proxyKind") }}</option>
        </select>
      </label>
      <template v-if="profileForm.kind === 'proxy'">
        <label>
          {{ t("networkSettings.proxyUrl") }}
          <input v-model="profileForm.proxyUrl" autocomplete="url" data-testid="network-proxy-url" />
        </label>
        <label>
          {{ t("networkSettings.proxyUsername") }}
          <input v-model="profileForm.username" autocomplete="username" data-testid="network-proxy-username" />
        </label>
        <label>
          {{ t("networkSettings.proxyPasswordRef") }}
          <input v-model="profileForm.passwordRefId" autocomplete="off" data-testid="network-proxy-password-ref" />
        </label>
        <label>
          {{ t("networkSettings.proxyPassword") }}
          <input v-model="profileForm.password" type="password" autocomplete="new-password" data-testid="network-proxy-password" />
        </label>
        <button type="button" :disabled="savingFormSecret || readOnly || !profileForm.passwordRefId.trim() || !profileForm.password" data-testid="network-proxy-password-save" @click="saveFormSecret(profileForm.passwordRefId, profileForm.password, 'password')">
          {{ t("networkSettings.saveProxyPassword") }}
        </button>
      </template>
      <label>
        {{ t("networkSettings.targetOrigin") }}
        <input v-model="profileForm.targetOrigin" autocomplete="url" data-testid="network-target-origin" placeholder="https://api.example.com" />
      </label>
      <label>
        {{ t("networkSettings.caPaths") }}
        <textarea v-model="profileForm.caCertificatePaths" rows="2" data-testid="network-ca-paths" />
      </label>
      <label>
        {{ t("networkSettings.clientCertificatePaths") }}
        <textarea v-model="profileForm.clientCertificatePaths" rows="2" data-testid="network-client-cert-paths" />
      </label>
      <label>
        {{ t("networkSettings.privateKeyRef") }}
        <input v-model="profileForm.clientPrivateKeyRefId" autocomplete="off" data-testid="network-client-key-ref" />
      </label>
      <button v-if="profileForm.clientPrivateKeyRefId.trim()" type="button" data-testid="network-private-key-ref-use" @click="usePrivateKeyRefForImport">
        {{ t("networkSettings.usePrivateKeyRefForImport") }}
      </button>
      <label>
        {{ t("networkSettings.passphraseRef") }}
        <input v-model="profileForm.clientKeyPassphraseRefId" autocomplete="off" data-testid="network-client-passphrase-ref" />
      </label>
      <label>
        {{ t("networkSettings.passphrase") }}
        <input v-model="profileForm.clientKeyPassphrase" type="password" autocomplete="new-password" data-testid="network-client-passphrase" />
      </label>
      <button type="button" :disabled="savingFormSecret || readOnly || !profileForm.clientKeyPassphraseRefId.trim() || !profileForm.clientKeyPassphrase" data-testid="network-passphrase-save" @click="saveFormSecret(profileForm.clientKeyPassphraseRefId, profileForm.clientKeyPassphrase, 'passphrase')">
        {{ t("networkSettings.savePassphrase") }}
      </button>
      <label class="verify-setting">
        <input v-model="profileForm.targetVerify" type="checkbox" data-testid="network-target-verify" />
        {{ t("networkSettings.verifyTargetTls") }}
      </label>
      <button type="button" :disabled="readOnly || !profileForm.name.trim()" data-testid="network-profile-add" @click="addProfileFromForm">
        {{ t("networkSettings.addProfile") }}
      </button>
      <p role="status" data-testid="network-profile-result">{{ profileMessage }}</p>
      <p role="status" data-testid="network-form-secret-result">{{ formSecretMessage }}</p>
    </fieldset>
    <label>
      {{ t("networkSettings.profilesAdvanced") }}
      <textarea v-model="profilesText" rows="9" spellcheck="false" data-testid="network-profiles-json" />
    </label>
    <p v-if="verificationWarning" class="warning" role="alert" data-testid="network-verification-warning">
      {{ t("networkSettings.verificationWarning") }}
    </p>
    <button type="button" :disabled="loading || saving || readOnly" data-testid="network-save" @click="saveConfiguration">
      {{ t("networkSettings.saveConfiguration") }}
    </button>
    <p role="status" data-testid="network-config-result">{{ configurationMessage }}</p>

    <fieldset>
      <legend>{{ t("networkSettings.secretReferences") }}</legend>
      <ul>
        <li v-for="entry in secretStatuses" :key="`${entry.ref.policy}:${entry.ref.id}`">
          {{ entry.ref.id }} — {{ t(`contract.credentialStatus.${entry.status}`) }}
        </li>
        <li v-if="secretStatuses.length === 0">{{ t("networkSettings.noConfiguredSecrets") }}</li>
      </ul>
      <label>
        {{ t("networkSettings.secretRefId") }}
        <input v-model="secretRefId" autocomplete="off" data-testid="network-secret-ref" />
      </label>
      <button type="button" :disabled="!secretRefId.trim() || importing || readOnly" data-testid="network-secret-import" @click="importSecret">
        {{ t("networkSettings.chooseSecretFile") }}
      </button>
      <p role="status" data-testid="network-secret-result">{{ secretMessage }}</p>
    </fieldset>
  </section>
</template>

<style scoped>
.network-settings { display: flex; flex-direction: column; gap: 10px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.network-settings label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.network-settings select, .network-settings textarea, .network-settings input { width: 100%; box-sizing: border-box; }
.network-settings textarea { font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
.network-settings button { align-self: flex-start; }
.network-settings .profile-form { display: flex; flex-direction: column; gap: 8px; }
.network-settings .verify-setting { flex-direction: row; align-items: center; }
.network-settings .verify-setting input { width: auto; }
.network-settings .note { margin: 0; color: var(--muted); font-size: 12px; }
.network-settings .warning { color: #b45309; margin: 0; }
.network-settings fieldset { display: flex; flex-direction: column; gap: 8px; }
.network-settings fieldset ul { margin: 0; padding-inline-start: 20px; }
</style>
