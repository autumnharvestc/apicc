// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import NetworkSettings from "../../../src/renderer/src/components/NetworkSettings.vue";
import { contractAssetFixture } from "../helpers/contract-assets.js";

enableAutoUnmount(afterEach);

describe("NetworkSettings", () => {
  it("saves a project/environment selection and keeps secret import as a separate host outcome", async () => {
    const fixture = await contractAssetFixture();
    await fixture.api.envCreate({ locator: fixture.projectLocator, name: "dev", variables: {}, baseUrls: {} });
    const { i18n } = createI18nInstance();
    i18n.global.locale.value = "en";
    const wrapper = mount(NetworkSettings, {
      props: { api: fixture.api, locator: fixture.projectLocator, readOnly: false },
      global: { plugins: [i18n] },
    });
    await flushPromises();

    const initial = await fixture.api.networkProfilesGet(fixture.projectLocator);
    const environment = initial.environments[0]!;
    await wrapper.get('[data-testid="network-scope"]').setValue(environment.id);
    await wrapper.get('[data-testid="network-profile-name"]').setValue("Local proxy");
    await wrapper.get('[data-testid="network-profile-kind"]').setValue("proxy");
    await wrapper.get('[data-testid="network-proxy-url"]').setValue("http://127.0.0.1:8080");
    await wrapper.get('[data-testid="network-proxy-username"]').setValue("proxy-user");
    await wrapper.get('[data-testid="network-proxy-password-ref"]').setValue("proxy-password");
    await wrapper.get('[data-testid="network-proxy-password"]').setValue("synthetic-password");
    await wrapper.get('[data-testid="network-target-origin"]').setValue("https://api.example.test");
    await wrapper.get('[data-testid="network-ca-paths"]').setValue("C:\\owned\\ca.pem");
    await wrapper.get('[data-testid="network-client-cert-paths"]').setValue("C:\\owned\\client.pem");
    await wrapper.get('[data-testid="network-client-key-ref"]').setValue("client-key");
    await wrapper.get('[data-testid="network-client-passphrase-ref"]').setValue("client-key-passphrase");
    await wrapper.get('[data-testid="network-client-passphrase"]').setValue("synthetic-passphrase");
    await wrapper.get('[data-testid="network-target-verify"]').setValue(false);
    await wrapper.get('[data-testid="network-proxy-password-save"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="network-passphrase-save"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="network-form-secret-result"]').text()).toContain("saved");
    await wrapper.get('[data-testid="network-profile-add"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="network-verification-warning"]').exists()).toBe(true);

    const originalGet = fixture.api.networkProfilesGet.bind(fixture.api);
    const originalSave = fixture.api.networkProfilesSave.bind(fixture.api);
    const saveRevisions: string[] = [];
    const refreshFlags: boolean[] = [];
    let failNextRefresh = false;
    fixture.api.networkProfilesGet = async (locator) => {
      refreshFlags.push(failNextRefresh);
      if (failNextRefresh) {
        failNextRefresh = false;
        throw new Error("synthetic status refresh failure");
      }
      return originalGet(locator);
    };
    fixture.api.networkProfilesSave = async (input) => {
      saveRevisions.push(input.revision);
      const result = await originalSave(input);
      failNextRefresh = saveRevisions.length === 1;
      return result;
    };

    await wrapper.get('[data-testid="network-save"]').trigger("click");
    await flushPromises();
    expect(saveRevisions).toHaveLength(1);
    expect(refreshFlags.at(-1)).toBe(true);
    expect(wrapper.get('[data-testid="network-config-result"]').text()).toContain("saved");
    expect(wrapper.get('[data-testid="network-config-result"]').text()).toContain("status could not be refreshed");

    await wrapper.get('[data-testid="network-save"]').trigger("click");
    await flushPromises();
    expect(saveRevisions).toHaveLength(2);
    expect(saveRevisions[1]).not.toBe(saveRevisions[0]);
    expect(wrapper.text()).toContain("Credential available");

    const saved = await fixture.api.networkProfilesGet(fixture.projectLocator);
    expect(saved.configuration.profiles).toMatchObject([{
      name: "Local proxy",
      kind: "proxy",
      proxyUrl: "http://127.0.0.1:8080",
      username: "proxy-user",
      passwordRef: { id: "proxy-password", policy: "test-auto" },
      targetTlsBindings: [{
        origin: "https://api.example.test",
        tls: {
          verify: false,
          caCertificatePaths: ["C:\\owned\\ca.pem"],
          clientCertificatePaths: ["C:\\owned\\client.pem"],
          clientPrivateKeyRef: { id: "client-key", policy: "test-auto" },
          clientKeyPassphraseRef: { id: "client-key-passphrase", policy: "test-auto" },
        },
      }],
    }]);
    expect(saved.configuration.environmentSelections).toEqual([{ environmentId: environment.id, selection: { kind: "profile", profileId: saved.configuration.profiles[0]!.id } }]);
    expect(wrapper.get('[data-testid="network-config-result"]').text()).toContain("saved");
    expect(saved.secretStatuses).toEqual(expect.arrayContaining([
      { ref: { id: "proxy-password", policy: "test-auto" }, status: "available" },
      { ref: { id: "client-key-passphrase", policy: "test-auto" }, status: "available" },
    ]));
    await wrapper.get('[data-testid="network-secret-ref"]').setValue("synthetic-key-ref");
    const importLocales: Array<string | undefined> = [];
    const originalImport = fixture.api.networkSecretImport.bind(fixture.api);
    fixture.api.networkSecretImport = async (input) => {
      importLocales.push(input.locale);
      return originalImport(input);
    };
    await wrapper.get('[data-testid="network-secret-import"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="network-secret-result"]').text()).toContain("cancelled");
    expect(importLocales).toEqual(["en"]);
    expect(wrapper.get('[data-testid="network-config-result"]').text()).toContain("saved");

    fixture.api.networkSecretImport = async () => {
      failNextRefresh = true;
      return { outcome: "saved", status: "available" };
    };
    await wrapper.get('[data-testid="network-secret-import"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="network-secret-result"]').text()).toContain("saved");
    expect(wrapper.get('[data-testid="network-secret-result"]').text()).toContain("status could not be refreshed");
  });
});
