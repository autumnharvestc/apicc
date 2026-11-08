// @vitest-environment jsdom
import { afterEach, beforeAll, it, expect, vi } from 'vitest';
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from '@vue/test-utils';
import { Modal } from 'ant-design-vue';
import ContainerManageDialog from '../../../src/renderer/src/components/ContainerManageDialog.vue';
import ContractDesigner from '../../../src/renderer/src/components/ContractDesigner.vue';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import { useEditorStore } from '../../../src/renderer/src/stores/editor.js';
import { contractAssetEditorFixture } from '../helpers/contract-assets.js';
import type { ApiccApi } from '../../../src/shared/types.js';
enableAutoUnmount(afterEach);
beforeAll(() => Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }));
it.each(['zh-CN', 'en'] as const)('P3h names container script controls and retains save identity in %s', async locale => {
  const { i18n } = createI18nInstance(); i18n.global.locale.value = locale;
  const target = { kind: 'collection' as const, locator: { workspaceId: 'w', groupId: 'g', projectId: 'p', collectionId: 'c' } };
  const ops = [{ id: 'first', type: 'script', content: 'first()' }, { id: 'second', type: 'script', content: 'second()' }];
  const api = { containerGet: vi.fn(async () => ({ kind: 'collection', operations: { variables: {}, preOperations: ops, postOperations: [] } })), containerSave: vi.fn(async () => {}) };
  const wrapper = mount(ContainerManageDialog, { props: { api: api as unknown as ApiccApi, target, name: 'Synthetic module', readOnly: false, reportError: () => {} }, global: { plugins: [i18n] } });
  await flushPromises();
  const body = new DOMWrapper(document.body);
  await body.findAll('[role="tab"]').find(x => x.text() === (locale === 'en' ? 'Pre-operations' : '前置操作'))!.trigger('click'); await flushPromises();
  const down = body.findAll('button').find(x => x.attributes('aria-label') === (locale === 'en' ? 'Move operation 1 down' : '下移操作 1'));
  expect(down).toBeDefined(); await down!.trigger('click');
  wrapper.findComponent(Modal).vm.$emit('ok'); await flushPromises();
  expect(api.containerSave).toHaveBeenCalledWith({ ...target, operations: { variables: {}, preOperations: [ops[1], ops[0]], postOperations: [] } });
});
it.each(['zh-CN', 'en'] as const)('P3h localizes contract enums without changing protocol values in %s', async locale => {
  const fixture = await contractAssetEditorFixture(); const editor = useEditorStore(fixture.api, () => ({ root: fixture.root, readOnly: false })); await editor.load(fixture.apiLocator);
  const { i18n } = createI18nInstance(); i18n.global.locale.value = locale;
  const wrapper = mount(ContractDesigner, { props: { editor, draftScope: 'contract', drafts: {} }, global: { plugins: [i18n] } });
  expect(wrapper.get('[data-testid="design-api-status"] option[value="draft"]').text()).toBe(locale === 'en' ? 'Draft' : '草稿');
  expect(wrapper.get('[data-testid="design-auth-kind"] option[value="none"]').text()).toBe(locale === 'en' ? 'No authentication' : '无鉴权');
  await wrapper.get('[data-testid="design-api-status"]').setValue('published');
  await wrapper.get('[data-testid="design-auth-kind"]').setValue('basic');
  expect(editor.api!.contract.metadata.status).toBe('published'); expect(editor.api!.contract.request.auth.kind).toBe('basic');
});
