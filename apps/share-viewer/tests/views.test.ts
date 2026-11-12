import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, it, expect, vi } from 'vitest';
import App from '../src/App.vue';
import { reportFixture, documentFixture, xss } from './fixtures.js';
import { renderPublicArtifactHtml } from '@apicc/core/collaboration/presentation';
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('shows an escaped short fingerprint in the offline default header while preserving folded full details',()=>{
  const dto=documentFixture();dto.source.digest='<&"1234567890-long-full-digest';
  const offline=new DOMParser().parseFromString(renderPublicArtifactHtml(dto),'text/html');
  const header=offline.body.querySelector(':scope > p');
  expect.soft(header?.textContent).toBe('内容指纹 / Content fingerprint: <&"123456789');
  expect.soft(header?.querySelector('code')?.closest('details')).toBeNull();
  const full=offline.querySelector('details')!;
  expect.soft(full.hasAttribute('open')).toBe(false);expect.soft(full.querySelector('p')?.textContent).toBe('<&"1234567890-long-full-digest');
  expect.soft(offline.querySelector('script,img,iframe')).toBeNull();
});
it('shows real Chinese report facts and switches all fixed labels to English', async () => {
  const wrapper = mount(App, { props:{artifact:reportFixture()}, attachTo:document.body });
  expect.soft(wrapper.text()).toContain('结论'); expect.soft(wrapper.text()).toContain('逻辑单元'); expect.soft(wrapper.text()).toContain('真实请求');
  expect.soft(wrapper.text()).toContain('传输失败'); expect.soft(wrapper.text()).toContain('未采集'); expect.soft(wrapper.text()).toContain('毫秒');
  expect.soft(wrapper.text()).toContain('单个观测桶'); expect.soft(wrapper.text()).toContain('123'); expect.soft(wrapper.text()).toContain('UTC');
  expect.soft(wrapper.text()).toContain('future-unknown-reason'); expect.soft(wrapper.text()).toContain('保留最初失败');
  expect.soft(wrapper.find('#nodes').text()).toContain('12.346 毫秒');
  expect.soft(wrapper.findAll('details').at(-1)!.text()).toContain('12.3456789');
  expect.soft(wrapper.findAll('table').length).toBeGreaterThan(2);
  expect.soft(wrapper.find('#populations tbody tr').findAll('td').map(c=>c.text())).toEqual(['逻辑单元','4','4','0','未采集']);
  expect.soft(wrapper.find('#requests').text()).toContain('10'); expect.soft(wrapper.find('#requests').text()).toContain('6');
  expect.soft(wrapper.findAll('details').every(x => !x.attributes('open'))).toBe(true);
  expect.soft(wrapper.find('input[type="search"]').exists()).toBe(true);
  const english = wrapper.find('button[data-language="en"]'); expect(english.exists()).toBe(true);
  await english.trigger('click'); expect.soft(wrapper.text()).toContain('Logical units'); expect.soft(wrapper.text()).toContain('Real requests'); expect.soft(wrapper.text()).toContain('Not collected');
});
it('boots from current fragment and obtains safe publication from actual viewer fetch', async () => {
  history.replaceState(null,'','/s/'+'a'.repeat(22)+'#key=synthetic-secret&section=nodes');
  let request!: Request;
  vi.stubGlobal('fetch',vi.fn(async (input:Request) => { request=input; return new Response(JSON.stringify(reportFixture()),{headers:{'X-Apicc-Download-Allowed':'true','X-Apicc-Publication-Version':'3'}}); }));
  const wrapper=mount(App,{attachTo:document.body}); await flushPromises();
  expect(wrapper.find('h1').exists()).toBe(true);
  expect.soft(wrapper.text()).toContain('发布版本: 3');
  expect.soft(request.headers.get('X-Apicc-Share-Key')).toBe('synthetic-secret');
  expect.soft(new URL(request.url).hash).toBe(''); expect.soft(request.url).not.toContain('synthetic-secret');
  expect.soft(document.body.textContent).not.toContain('synthetic-secret');
  expect.soft(wrapper.find('button[data-action="refresh"]').exists()).toBe(true);
  expect.soft(wrapper.find('button[data-action="download"]').exists()).toBe(true);
});
it.each([0, 2])('shows only actual %s trend buckets with honest limits', points => {
  const wrapper = mount(App,{props:{artifact:reportFixture(points)}});
  expect(wrapper.text()).toContain(points === 0 ? '没有观测桶' : '真实观测桶');
});
it('renders contract body/schema/examples and malicious markup literally without active elements', () => {
  const wrapper = mount(App, {props:{artifact:documentFixture()}, attachTo:document.body});
  expect.soft(wrapper.text()).toContain(xss); expect.soft(wrapper.text()).toContain('公开示例'); expect.soft(wrapper.text()).toContain('模型'); expect.soft(wrapper.text()).toContain('{"example":"literal"}');
  expect.soft(wrapper.findAll('img,script,iframe,form').length).toBe(0);
  expect.soft(wrapper.findAll('button').some(b=>b.text().includes('发送'))).toBe(false);
});
it('keeps search hits in content and sections independent of the key', async () => {
  history.replaceState(null, '', '/s/'+'a'.repeat(22)+'#key=synthetic-secret&section=api-2');
  const storage = vi.spyOn(Storage.prototype, 'setItem'); const logs = vi.spyOn(console,'log');
  const wrapper = mount(App,{props:{artifact:documentFixture()}, attachTo:document.body});
  const input = wrapper.find('input[type="search"]'); expect(input.exists()).toBe(true);
  await input.setValue('公开示例'); expect(wrapper.find('main').text()).toContain('公开示例');
  const link = wrapper.find('nav a'); expect(link.exists()).toBe(true); await link.trigger('click');
  expect.soft(location.hash).toContain('key=synthetic-secret'); expect.soft(document.body.textContent).not.toContain('synthetic-secret');
  expect.soft(storage).not.toHaveBeenCalled(); expect.soft(logs).not.toHaveBeenCalled();
});
function setupLive(downloadAllowed=true, source=reportFixture()) {
  history.replaceState(null,'','/s/'+'a'.repeat(22)+'#key=synthetic-secret&section=nodes');
  const requests:Request[]=[];
  const responses:Response[]=[new Response(JSON.stringify(source),{headers:{'X-Apicc-Download-Allowed':String(downloadAllowed),'X-Apicc-Publication-Version':'3'}})];
  vi.stubGlobal('fetch',vi.fn(async(input:Request)=>{requests.push(input);return responses.shift()!;}));
  return {requests,responses};
}
it.each(['refresh','download'])('clears a previous successful body on every failed %s and offers a finite next step', async action => {
  for(const [status,reason,expected] of [[404,'','共享内容不可用'],[410,'expired','授权已到期'],[410,'revoked','授权已撤销'],[410,'responsibility_changed','发布责任资格已变化'],[410,'policy_changed','共享策略已变化'],[410,'publication_disabled','发布已停用'],[429,'','访问容量已满'],[503,'','服务暂不可用']] as const) {
    const f=setupLive();const wrapper=mount(App,{attachTo:document.body});await flushPromises();
    expect(wrapper.find('h1').exists()).toBe(true);
    f.responses.push(new Response(JSON.stringify({reason}),{status}));
    await wrapper.find(`button[data-action="${action}"]`).trigger('click');await flushPromises();
    expect.soft(wrapper.find('h1').exists(),String(status)+reason).toBe(false);
    expect.soft(wrapper.text()).toContain(expected);
    expect.soft(wrapper.text()).toMatch(/联系分享者|稍后重试/);
    expect.soft(wrapper.find('button[data-action="download"]').exists()).toBe(false);
    wrapper.unmount();
  }
});
it('has no pseudo-download action without permission and no borrowed member storage when key is missing', async () => {
  setupLive(false); const wrapper=mount(App);await flushPromises();expect(wrapper.find('h1').exists()).toBe(true);expect(wrapper.find('button[data-action="download"]').exists()).toBe(false);wrapper.unmount();
  history.replaceState(null,'','/s/'+'a'.repeat(22));
  const storage=vi.spyOn(Storage.prototype,'getItem');const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const absent=mount(App);await flushPromises();expect.soft(absent.text()).toContain('共享内容不可用');expect.soft(absent.text()).toContain('联系分享者');expect.soft(fetcher).not.toHaveBeenCalled();expect.soft(storage).not.toHaveBeenCalled();
});
it('downloads only newly authorized DTO as real controlled HTML without key or old cached body', async () => {
  const f=setupLive();const wrapper=mount(App,{attachTo:document.body});await flushPromises();
  const fresh=documentFixture();fresh.title='NEW_DOWNLOAD_ONLY';f.responses.push(new Response(JSON.stringify(fresh)));
  let file!:Blob;const create=vi.fn((blob:Blob)=>{file=blob;return 'blob:synthetic';});const revoke=vi.fn();
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:create});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revoke});
  let filename='';vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){filename=this.download;});
  await wrapper.find('button[data-action="download"]').trigger('click');await flushPromises();
  expect(f.requests).toHaveLength(2);expect(f.requests[1]!.url).toBe(location.origin+'/share-api/'+'a'.repeat(22)+'/download');expect(f.requests[1]!.headers.get('X-Apicc-Share-Key')).toBe('synthetic-secret');
  expect(file.type).toBe('text/html;charset=utf-8');const body=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsText(file);});
  expect.soft(body).toContain('NEW_DOWNLOAD_ONLY');expect.soft(body).not.toContain('synthetic-secret');expect.soft(body).not.toContain('公开结果');expect.soft(filename).toMatch(/\.html$/);expect.soft(revoke).toHaveBeenCalledWith('blob:synthetic');
});
it('does not resurrect a stale read after a newer failed refresh', async()=>{
  setupLive();const wrapper=mount(App);await flushPromises();
  let finish!:(response:Response)=>void;let calls=0;
  vi.stubGlobal('fetch',vi.fn(()=>++calls===1?new Promise<Response>(resolve=>finish=resolve):Promise.resolve(new Response('{}',{status:410}))));
  const refresh=wrapper.find('button[data-action="refresh"]');await refresh.trigger('click');await refresh.trigger('click');await flushPromises();finish(new Response(JSON.stringify(reportFixture())));await flushPromises();
  expect(wrapper.find('h1').exists()).toBe(false);
});
it('copies a literal supported snippet without issuing any real target request', async()=>{
  setupLive(false,documentFixture());const wrapper=mount(App);await flushPromises();
  const write=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:write}});
  const copy=wrapper.find('button[data-action="copy"]');expect(copy.exists()).toBe(true);await copy.trigger('click');await flushPromises();
  expect.soft(write).toHaveBeenCalled();expect.soft(vi.mocked(fetch)).toHaveBeenCalledTimes(1);expect.soft(wrapper.text()).toContain('已复制');
});
it('retains freshly authorized facts and offers a safe step when escaped offline file exceeds the existing artifact ceiling', async()=>{
  const f=setupLive();const wrapper=mount(App,{global:{config:{errorHandler:()=>{}}}});await flushPromises();
  const large=documentFixture();large.title='<'.repeat(6*1024*1024);f.responses.push(new Response(JSON.stringify(large)));
  const create=vi.fn();Object.defineProperty(URL,'createObjectURL',{configurable:true,value:create});
  await wrapper.find('button[data-action="download"]').trigger('click');await flushPromises();
  expect.soft(wrapper.find('h1').exists()).toBe(true);expect.soft(wrapper.text()).toContain('离线文件超过生成上限');expect.soft(wrapper.text()).toContain('联系分享者');expect.soft(create).not.toHaveBeenCalled();
});
it('handles unavailable or refused clipboard without a target request or unhandled error', async()=>{
  for(const clipboard of [undefined,{writeText:async()=>{throw new Error('denied');}}]){
    setupLive(false,documentFixture());const error=vi.fn();const wrapper=mount(App,{global:{config:{errorHandler:error}}});await flushPromises();Object.defineProperty(navigator,'clipboard',{configurable:true,value:clipboard});
    await wrapper.find('button[data-action="copy"]').trigger('click');await flushPromises();
    expect.soft(error).not.toHaveBeenCalled();expect.soft(wrapper.text()).toContain('复制不可用，请手动选择片段');expect.soft(vi.mocked(fetch)).toHaveBeenCalledTimes(1);wrapper.unmount();
  }
});
it('releases the object URL and retains fresh facts when browser export fails',async()=>{
  const f=setupLive();const wrapper=mount(App,{global:{config:{errorHandler:()=>{}}}});await flushPromises();f.responses.push(new Response(JSON.stringify(documentFixture())));
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:()=> 'blob:failed-export'});const revoke=vi.fn();Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:revoke});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{throw new Error('navigation denied');});
  await wrapper.find('button[data-action="download"]').trigger('click');await flushPromises();
  expect.soft(revoke).toHaveBeenCalledWith('blob:failed-export');expect.soft(wrapper.text()).toContain('离线文件无法生成');expect.soft(wrapper.find('h1').exists()).toBe(true);
});
it('offers an explicit bilingual empty state and clears only publication search with focus',async()=>{
  const wrapper=mount(App,{props:{artifact:reportFixture()},attachTo:document.body});
  await wrapper.get('input[type="search"]').setValue('not-present');
  expect(wrapper.findAll('main section')).toHaveLength(0);
  expect(wrapper.get('[data-testid="search-empty"]').text()).toContain('没有匹配章节');
  await wrapper.get('[data-language="en"]').trigger('click');
  expect(wrapper.get('[data-language="en"]').attributes('aria-pressed')).toBe('true');
  expect(wrapper.get('[data-testid="search-empty"]').text()).toContain('No matching sections');
  await wrapper.get('[data-action="clear-search"]').trigger('click');
  expect(wrapper.findAll('main section').length).toBeGreaterThan(0);
  expect(document.activeElement).toBe(wrapper.get('input[type="search"]').element);
  wrapper.unmount();
});
it('exports language-specific offline navigation without scripts or duplicate anchor identities',()=>{
  const offline=new DOMParser().parseFromString(renderPublicArtifactHtml(reportFixture()),'text/html');
  for(const lang of ['zh','en']){
    const scope=offline.querySelector('.'+lang)!;
    const links=[...scope.querySelectorAll<HTMLAnchorElement>('nav a')];expect(links.length).toBeGreaterThan(5);
    for(const link of links) expect(scope.querySelector(link.getAttribute('href')!)).not.toBeNull();
  }
  const ids=[...offline.querySelectorAll('[id]')].map(x=>x.id);expect(new Set(ids).size).toBe(ids.length);
  expect(offline.querySelector('script,img,iframe')).toBeNull();
});
