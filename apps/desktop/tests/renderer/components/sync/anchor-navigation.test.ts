// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { mountSyncPanel } from './fixtures.js';

it('section navigation stays in the panel scroller without fragment-navigation of its ancestors', async () => {
  const f = await mountSyncPanel('en'), ancestor = document.createElement('div');
  const originalUrl = location.href;
  document.body.append(ancestor); ancestor.append(f.wrapper.element); ancestor.style.overflow = 'hidden'; ancestor.scrollTop = 37;
  const scroller = f.wrapper.get('.sync-scroll').element as HTMLElement;
  const requests: { owner: unknown; top?: number; behavior?: ScrollBehavior }[] = [];
  // jsdom has no layout/scrollTo implementation. Only the browser's scroll
  // commit boundary is supplied; real DOM event/default URL behavior is intact.
  Object.defineProperty(scroller, 'scrollTo', { configurable: true, value(this: HTMLElement, options: ScrollToOptions) { requests.push({ owner: this, ...options }); this.scrollTop = options.top ?? this.scrollTop; } });
  try {
    await f.showCandidate('project-a');
    await f.wrapper.get('[data-testid="sync-edit-source"]').trigger('click');
    await f.wrapper.get('input[type="url"]').setValue('https://source.test/unsaved.yaml');
    expect(f.wrapper.get('#sync-settings').element.isConnected).toBe(true);
    const settings = f.wrapper.get('nav a[href="#sync-settings"]').element as HTMLAnchorElement;
    settings.click(); await new Promise(done => setTimeout(done, 20)); await f.flush();
    expect(location.href).toBe(originalUrl);
    expect(ancestor.scrollTop).toBe(37);
    expect(requests).toHaveLength(1); expect(requests[0]!.owner).toBe(scroller);
    expect(requests[0]!.behavior).toBe('smooth'); expect(Number.isFinite(requests[0]!.top)).toBe(true);
    expect(document.activeElement).toBe(f.wrapper.get('#sync-settings').element);
    expect(f.wrapper.get<HTMLInputElement>('input[type="url"]').element.value).toBe('https://source.test/unsaved.yaml');
    expect(f.savedSources()).toHaveLength(0); expect(f.applicationCalls()).toHaveLength(0);
    expect(f.wrapper.get('[data-testid="sync-search"]').element.closest('header')).not.toBeNull();
  } finally { history.replaceState(null, '', originalUrl); f.unmount(); ancestor.remove(); }
});
