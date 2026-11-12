import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
type ReaderWindow = Window & typeof globalThis;
type ReaderDom = { window: ReaderWindow };
// The test uses only this small jsdom surface; no new runtime/type dependency.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html:string, options:{runScripts:string;beforeParse:(w:ReaderWindow)=>void})=>ReaderDom };
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDocumentHtml } from '../../../packages/core/src/design/document.js';
import { buildDocumentProjection } from '../../../packages/core/src/design/projection.js';
import { createProjectSnapshot } from '../../../packages/core/src/assets/snapshot.js';
import { projectionProject } from '../../../packages/core/tests/helpers/designDocumentFixture.js';
import { renderStressHtml } from '../../../packages/core/src/stress/html.js';
import { stressReportFixture } from '../../../packages/core/tests/helpers/stressReport.js';
import { htmlReporter } from '../../../packages/core/src/report/html.js';
import type { RunResult } from '../../../packages/core/src/report/types.js';
const windows: ReaderDom[] = [];
const dirs: string[] = [];
afterEach(() => { windows.splice(0).forEach(d => d.window.close()); dirs.splice(0).forEach(d => rmSync(d, {recursive:true,force:true})); });
function open(html: string) {
  const dom = new JSDOM(html, { runScripts:'dangerously', beforeParse(w) { w.scrollTo=()=>{}; } });
  windows.push(dom); return dom.window;
}
function input(w: ReturnType<typeof open>, id: string, value: string, event='input') {
  const field=w.document.getElementById(id) as HTMLInputElement; field.value=value; field.dispatchEvent(new w.Event(event,{bubbles:true}));
}
it('localizes document labels and dynamic counts without translating or replacing request payloads', async () => {
  const project=projectionProject(); project.name='Request';
  const w=open(renderDocumentHtml(buildDocumentProjection(createProjectSnapshot(project),{kind:'project'})));
  const d=w.document, original=d.querySelector('code')?.textContent;
  expect(d.documentElement.lang).toBe('zh-CN'); expect(d.querySelector('main h1')?.textContent).toBe('Request');
  expect(d.querySelector('label[for="document-search"]')?.textContent).toContain('搜索');
  input(w,'document-search','not-present'); expect(d.querySelectorAll('section.api:not([hidden])')).toHaveLength(0);
  expect(d.getElementById('search-summary')?.textContent).toContain('0 / 1');
  input(w,'reader-language','en','change'); expect(d.documentElement.lang).toBe('en');
  expect(d.getElementById('search-summary')?.textContent).toBe('Showing 0 of 1 APIs');
  input(w,'document-search',''); expect(d.querySelectorAll('section.api:not([hidden])')).toHaveLength(1);
  expect(d.querySelector('code')?.textContent).toBe(original);
  const writeText = (value:string) => { expect(value).toBe(d.querySelector('.code-sample:has([data-copy-button]) code')?.textContent); return Promise.resolve(); };
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText}});
  const copy=d.querySelector<HTMLButtonElement>('[data-copy-button]')!; copy.click(); await Promise.resolve();
  await vi.waitFor(()=>expect(copy.textContent).toBe('Copied')); input(w,'reader-language','zh-CN','change'); expect(copy.textContent).toBe('已复制');
});
it('keeps stress section navigation and empty results consistent, and clear restores focus in either language', () => {
  const w=open(renderStressHtml(stressReportFixture())),d=w.document;
  input(w,'filter','not-present'); expect(d.querySelectorAll('main section:not([hidden])')).toHaveLength(0);
  expect(d.querySelectorAll('aside nav a:not([hidden])')).toHaveLength(0);
  expect(d.getElementById('filter-empty')?.hidden).toBe(false);
  input(w,'language','en','change'); expect(d.getElementById('filter-empty')?.textContent).toContain('No matching');
  d.getElementById('filter-clear')!.click(); expect(d.activeElement?.id).toBe('filter');
  expect(d.querySelectorAll('main section:not([hidden])').length).toBeGreaterThan(5);
  expect(d.getElementById('filter-empty')?.hidden).toBe(true);
});
it('renders non-HTTP diagnostics as readable fields and switches run report labels while preserving filters and facts', async () => {
  const result:RunResult={collectionId:'c',collectionName:'失败',startedAt:'2026-11-12T00:00:00Z',finishedAt:'2026-11-12T00:00:01Z',total:1,passed:0,failed:1,cases:[{apiId:'a',apiName:'alpha',caseId:'t',caseName:'c',row:0,passed:false,durationMs:1,assertions:[],error:'business-original'}], workflow:{total:1,passed:0,failed:1,skipped:0,entries:[{entryId:'lost-node',kind:'workflow',workflowId:'w',status:'failed',error:'missing-definition'}]}};
  const out=mkdtempSync(join(tmpdir(),'p4b-reader-'));dirs.push(out);
  const w=open(readFileSync(await htmlReporter.render(result,out),'utf8')),d=w.document;
  const diagnostics=d.querySelector('#entry-diagnostics')!;
  expect(diagnostics).not.toBeNull(); expect(diagnostics.querySelector('td')?.textContent).toBe('lost-node');
  expect(diagnostics.textContent).toContain('missing-definition'); expect(diagnostics.querySelector('details')?.open).toBe(false);
  input(w,'api','alpha'); input(w,'reader-language','en','change');
  expect(d.querySelector('h1')?.textContent).toBe('失败'); expect(d.querySelector('label[for="api"]')?.textContent).toBe('API');
  expect(d.querySelector<HTMLElement>('tr.fail')?.hidden).toBe(false); expect(d.querySelector('tr.fail')?.textContent).toContain('business-original');
  expect((d.getElementById('api') as HTMLInputElement).value).toBe('alpha');
});

it.each(['constructor','__proto__'])('preserves unknown workflow kind and state %s without inherited-object lookup', async(code)=>{
  const out=mkdtempSync(join(tmpdir(),'p4b-unknown-'));dirs.push(out);
  const result:RunResult={collectionId:'c',collectionName:'unknown codes',startedAt:'2026-11-12T00:00:00Z',finishedAt:'2026-11-12T00:00:01Z',total:0,passed:0,failed:0,cases:[],workflow:{total:1,passed:1,failed:0,skipped:0,entries:[{entryId:'future',kind:'workflow',workflowId:'w',nodeKind:code,state:code,status:'passed'}]}};
  const w=open(readFileSync(await htmlReporter.render(result,out),'utf8'));
  const row=w.document.querySelector('#workflow-nodes tbody tr')!;
  expect(row.children[1]!.textContent).toBe(code);expect(row.children[2]!.textContent).toBe(code);
  input(w,'reader-language','en','change');expect(row.children[1]!.textContent).toBe(code);expect(row.children[2]!.textContent).toBe(code);
});
it('keeps user-named environments even when their names collide with fixed document labels',()=>{
  const project=projectionProject();
  project.collections[0]!.apis[0]!.cases=['base','env','Request','draft'].map((scope,index)=>({id:`10000000-0000-4000-8000-00000000009${index}`,name:`case-${index}`,scope,parameters:{},preOperations:[],postOperations:[],assertions:[]}));
  const w=open(renderDocumentHtml(buildDocumentProjection(createProjectSnapshot(project),{kind:'project'})));
  const scopes=()=>[...w.document.querySelectorAll('tbody tr')].filter(row=>row.children[0]?.textContent?.startsWith('case-')).map(row=>row.children[1]?.textContent);
  expect(scopes()).toEqual(['基础','env','Request','draft']);
  input(w,'reader-language','en','change');expect(scopes()).toEqual(['base','env','Request','draft']);
});
it('uses readable Chinese labels for the existing workflow node types',async()=>{
  const out=mkdtempSync(join(tmpdir(),'p4b-kinds-'));dirs.push(out);
  const kinds=['noop','assign','delay','assert','subflow'];
  const result:RunResult={collectionId:'c',collectionName:'kinds',startedAt:'2026-11-12T00:00:00Z',finishedAt:'2026-11-12T00:00:01Z',total:0,passed:0,failed:0,cases:[],workflow:{total:5,passed:5,failed:0,skipped:0,entries:kinds.map(nodeKind=>({entryId:nodeKind,kind:'workflow',workflowId:'w',nodeKind,status:'passed'}))}};
  const w=open(readFileSync(await htmlReporter.render(result,out),'utf8'));
  const values=()=>[...w.document.querySelectorAll('#workflow-nodes tbody tr')].map(row=>row.children[1]?.textContent);
  expect(values()).toEqual(['占位','赋值','延时','断言','子流程']);
  input(w,'reader-language','en','change');expect(values()).toEqual(kinds);
});
