// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { DOMWrapper, enableAutoUnmount, mount } from '@vue/test-utils';
import ProjectCard from '../../../src/renderer/src/components/ProjectCard.vue';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';

enableAutoUnmount(afterEach);
const name = '长项目名称 / Project with a long name';
function card(plain = false) {
  const { i18n } = createI18nInstance();
  return mount(ProjectCard, { attachTo: document.body, props: { projectId: 'preview', projectName: name, plain }, global: { plugins: [i18n] } });
}
describe('ProjectCard accessible actions', () => {
  it('provides a native named button to open the project once without invoking management', async () => {
    const wrapper = card();
    const open = wrapper.get('button.card-name');
    expect(open.attributes('type')).toBe('button');
    expect(open.text()).toBe(name);
    expect(open.attributes('title')).toBe(name);
    await open.trigger('click');
    expect(wrapper.emitted('open')).toHaveLength(1);
    expect(wrapper.emitted('remove')).toBeUndefined();
  });
  it('routes keyboard menu actions without opening the project and restores trigger focus', async () => {
    const wrapper = card();
    const more = wrapper.get('[data-testid="project-card-more"]');
    expect(more.attributes('aria-label')).toBeTruthy();
    await more.trigger('keydown', { key: 'ArrowDown' });
    const rename = document.body.querySelector('[data-testid="project-menu-rename"]');
    expect(document.activeElement).toBe(rename);
    await new DOMWrapper(rename!).trigger('keydown', { key: 'Escape' });
    expect(document.activeElement).toBe(more.element);
    expect(document.body.querySelector('[data-testid="project-menu-rename"]')).toBeNull();
    await more.trigger('click');
    await new DOMWrapper(document.body.querySelector('[data-testid="project-menu-move"]')!).trigger('click');
    expect(document.activeElement).toBe(more.element);
    expect(wrapper.emitted('move')).toHaveLength(1);
    expect(wrapper.emitted('open')).toBeUndefined();
  });
  it('keeps online plain cards openable without exposing local management', async () => {
    const wrapper = card(true);
    expect(wrapper.find('[data-testid="project-card-more"]').exists()).toBe(false);
    await wrapper.get('button.card-name').trigger('click');
    expect(wrapper.emitted('open')).toHaveLength(1);
  });
});
