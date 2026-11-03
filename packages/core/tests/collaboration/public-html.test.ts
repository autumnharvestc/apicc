import { it, expect } from 'vitest';
import { publicSections, renderPublicArtifactHtml } from '../../src/collaboration/presentation.js';
import { safeDocument, safeReport } from './fixtures.js';
import { PublicArtifactDtoSchema } from '../../src/collaboration/shared.js';
it('adapts real safe report into labeled facts without merging logical and request populations', () => {
  const dto = safeReport(); dto.report!.counts = [{labelCode:'logical.units',total:4,passed:4,failed:0}, {labelCode:'request.completed',total:10}]; dto.report!.failures = [{category:'transport',count:6}];
  const zh = JSON.stringify(publicSections(dto, 'zh-CN')), en = JSON.stringify(publicSections(dto, 'en'));
  expect.soft(zh).toContain('逻辑单元'); expect.soft(zh).toContain('真实请求'); expect.soft(zh).toContain('传输失败');
  expect.soft(en).toContain('Logical units'); expect.soft(en).toContain('Real requests');
});
it('renders escaped self-contained bilingual HTML from only safe DTO', () => {
  const dto = safeDocument(); dto.title = '<script>attack()</script>'; dto.document!.apis[0]!.documentation = '<img src="https://remote.invalid">';
  const html = renderPublicArtifactHtml(dto);
  expect.soft(html).toContain('&lt;script&gt;attack()&lt;/script&gt;');
  expect.soft(html).toContain('安全接口'); expect.soft(html).toContain('English'); expect.soft(html).toContain('请求');
  expect.soft(html).toContain('<details'); expect.soft(html).not.toMatch(/<script|<img|<iframe|<form|fetch\(|localStorage|sessionStorage/);
});
it('rejects private-field objects rather than serializing arbitrary fallback', () => {
  expect(() => renderPublicArtifactHtml({...safeDocument(), privateSource: 'must-not-render'})).toThrow();
});
it('bounds escaped offline output', () => {
  const dto = safeDocument(); dto.title = '<'.repeat(6*1024*1024);
  expect(() => renderPublicArtifactHtml(dto)).toThrow('public-html-size-limit');
});
it('localizes published report verdict summary and labels request comparison units',()=>{
  const dto=safeReport();dto.summary=[{labelCode:'report.verdict',value:'passed'}];
  const sections=publicSections(dto,'zh-CN');
  expect.soft(JSON.stringify(sections.find(s=>s.id==='summary'))).toContain('通过');
  expect.soft(JSON.stringify(sections.find(s=>s.id==='comparison'))).toContain('请求失败率');
  expect.soft(JSON.stringify(sections.find(s=>s.id==='comparison'))).toContain('毫秒');
});
it('explains missing observations explicitly without promoting raw data',()=>{
  const dto=safeReport();dto.report!.nodes=[];dto.report!.trace=[];dto.report!.evidence=[];
  const sections=publicSections(dto,'zh-CN');
  for(const id of ['nodes','events','evidence'])expect.soft(JSON.stringify(sections.find(s=>s.id===id))).toContain('未采集');
});
it('localizes fixed precision labels and distinguishes API version from publication version',()=>{
  const metrics=JSON.stringify(publicSections(safeReport(),'zh-CN').find(s=>s.id==='metrics'));
  expect.soft(metrics).toContain('下溢样本');expect.soft(metrics).toContain('上溢样本');expect.soft(metrics).toContain('平均值');
  expect.soft(JSON.stringify(publicSections(safeDocument(),'zh-CN').find(s=>s.id==='api-1'))).toContain('接口版本');
});
it('keeps invalid published time literal and readable instead of throwing during page rendering',()=>{
  const dto=safeReport();dto.report!.startedAt='invalid <script>time</script>';
  expect(()=>publicSections(dto,'zh-CN')).not.toThrow();
  expect(JSON.stringify(publicSections(dto,'zh-CN'))).toContain('时间格式无效');
});
it('puts report conclusion populations failures and integrity ahead of node details',()=>{
  const ids=publicSections(safeReport(),'zh-CN').map(s=>s.id);
  expect.soft(ids.slice(0,6)).toEqual(['conclusion','populations','requests','failures','completeness','limitations']);
  expect.soft(ids.indexOf('limitations')).toBeLessThan(ids.indexOf('nodes'));
});
it('renders all existing completeness reasons as readable bilingual cells and preserves unknown limitation text',()=>{
  const reasons=[
    ['cancelled','已取消','Cancelled'],['drain-timeout','排空超时','Drain timeout'],['warmup-drain-timeout','预热排空超时','Warmup drain timeout'],
    ['setup-failed','初始化失败','Setup failed'],['vu-setup-failed','VU 初始化失败','VU setup failed'],['teardown-failed','清理失败','Teardown failed'],['vu-teardown-failed','VU 清理失败','VU teardown failed'],
    ['worker-missing','工作进程缺失','Worker missing'],['worker-failed','工作进程失败','Worker failed'],['worker-incompatible','工作进程不兼容','Worker incompatible'],
    ['snapshot-missing','快照缺失','Snapshot missing'],['snapshot-duplicate','快照重复','Duplicate snapshot'],['snapshot-invalid','快照无效','Invalid snapshot'],
    ['metrics-budget-exhausted','指标预算耗尽','Metrics budget exhausted'],['histogram-overflow','直方图溢出','Histogram overflow'],['timeline-unaligned','趋势时间未对齐','Timeline unaligned'],['phase-window-missing','阶段窗口缺失','Phase window missing'],
    ['dropped','未启动迭代','Dropped iterations'],['no-data','没有数据','No data'],['policy-limited','受策略限制','Policy limited'],['resource-saturated','资源饱和','Resource saturated'],['execution-failed','执行失败','Execution failed'],
  ] as const;
  const dto=safeReport();dto.report!.verdict='incomplete';dto.report!.stress!.completeness.execution={complete:false,reasons:reasons.map(row=>row[0])};dto.limitations=[{code:'future-unknown-reason'}];
  const legal=PublicArtifactDtoSchema.parse(dto);
  for(const [language,column] of [['zh-CN',1],['en',2]] as const){
    const sections=publicSections(legal,language);const block=sections.find(s=>s.id==='completeness')!.blocks[0]!;
    expect(block.kind).toBe('table');if(block.kind!=='table')throw new Error('Expected actual completeness table');
    expect.soft(block.rows[0]![2]).toBe(reasons.map(row=>row[column]).join(' · '));
    expect.soft(sections.find(s=>s.id==='limitations')!.blocks).toEqual([{kind:'text',text:'future-unknown-reason'}]);
  }
});
it('distinguishes zero-baseline and other uncomputable relative changes from genuinely missing operands',()=>{
  const dto=safeReport();dto.report!.comparison!.metrics={
    rps:{base:0,candidate:1,absolute:1,relative:null},p95Ms:{base:0,candidate:0,absolute:0,relative:null},
    errorRate:{base:null,candidate:1,absolute:null,relative:null},iterationsCompleted:{base:0,candidate:null,absolute:null,relative:null},
    iterationP95Ms:{base:1e-320,candidate:1e308,absolute:1e308,relative:null},dropped:{base:1,candidate:2,absolute:1,relative:1},
  };
  const legal=PublicArtifactDtoSchema.parse(dto);
  for(const [language,zero,missing,uncomputable] of [['zh-CN','基线为 0，无法计算相对变化','未采集','无法计算相对变化'],['en','Baseline is 0; relative change cannot be calculated','Not collected','Relative change cannot be calculated']] as const){
    const block=publicSections(legal,language).find(s=>s.id==='comparison')!.blocks[2]!;
    expect(block.kind).toBe('table');if(block.kind!=='table')throw new Error('Expected actual comparison table');
    expect.soft(block.rows.map(row=>row[4])).toEqual([zero,zero,missing,missing,uncomputable,'100 %']);
    expect.soft(block.rows[0]!.slice(1,4)).toEqual(language==='en'?['0 requests/s','1 requests/s','1 requests/s']:['0 次/秒','1 次/秒','1 次/秒']);
  }
});
