// @vitest-environment jsdom
import { beforeAll, afterEach, it, expect } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';
import { createMemoryApi } from '../../../src/renderer/src/api/memory.js';
import { useWorkspaceStore } from '../../../src/renderer/src/stores/workspace.js';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import TestSidebar from '../../../src/renderer/src/components/TestSidebar.vue';

enableAutoUnmount(afterEach);
beforeAll(() => Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }));

it.each(['zh-CN', 'en'] as const)('P3g clears only navigation search and restores full locator in %s', async locale => {
  const api = createMemoryApi(); api.seedWorkspace();
  const workspace = useWorkspaceStore(api); await workspace.open('/tmp/ws');
  const project = workspace.tree!.children.flatMap(group => group.children ?? []).find(node => node.kind === 'project');
  if (!project || project.kind !== 'project') throw new Error('Missing seeded project');
  const target = project.children.flatMap(collection => collection.children ?? []).find(node => node.kind === 'api');
  if (!target || target.kind !== 'api') throw new Error('Missing seeded API');
  const { i18n } = createI18nInstance(); i18n.global.locale.value = locale;
  const wrapper = mount(TestSidebar, { attachTo: document.body, props: { workspace, activeProjectLocator: project.locator, activeApiLocator: target.locator, pane: 'api-cases', scenarios: [{ id: 'long', name: 'Scenario long name', locator: { ...project.locator, workflowId: 'long' } }], reportError: () => {} }, global: { plugins: [i18n] } });
  const search = wrapper.get('input');
  await search.setValue('not-present');
  expect(wrapper.text()).toContain(locale === 'en' ? 'No matching items' : '没有匹配项');
  await wrapper.get('button[data-testid="test-search-clear"]').trigger('click');
  expect(search.element.value).toBe(''); expect(document.activeElement).toBe(search.element);
  expect(wrapper.emitted('update:pane')).toBeUndefined(); expect(wrapper.emitted('pick-api')).toBeUndefined();
  const pick = wrapper.findAll('.api-item').find(item => item.get('.api-name').text() === target.label)!;
  expect(pick.attributes('title')).toContain(target.label);
  expect(pick.attributes('aria-current')).toBe('true');
  await pick.trigger('click'); expect(wrapper.emitted('pick-api')!.at(-1)).toEqual([target.locator]);
  await wrapper.setProps({ pane: 'scenario' }); await search.setValue('not-present');
  expect(wrapper.text()).toContain(locale === 'en' ? 'No matching items' : '没有匹配项');
  await wrapper.get('button[data-testid="test-search-clear"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('.scenario-name').attributes('title')).toBe('Scenario long name');
  expect(wrapper.emitted('open-workflow')).toBeUndefined();
});
