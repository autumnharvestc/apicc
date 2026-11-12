<script setup lang="ts">
import { computed, ref, onMounted, nextTick } from 'vue';
import type { PublicArtifactDto } from '@apicc/core/collaboration/shared';
import { publicSections, renderPublicArtifactHtml, type PublicLanguage } from '@apicc/core/collaboration/presentation';
import { readFragment, sectionFragment } from './fragment.js';
import { readPublic, type ReadResult } from './client.js';
const props = defineProps<{ artifact?: PublicArtifactDto }>();
const loaded=ref<PublicArtifactDto>();
const artifact=computed(()=>props.artifact??loaded.value);
const version=ref('');
const downloadAllowed=ref(false);
const failure=ref<Extract<ReadResult,{ok:false}>>();
const pending=ref(false);
const copied=ref(false);
const copyFailed=ref(false);
let generation=0;
const language=ref<PublicLanguage>('zh-CN');
const search=ref('');
const searchInput=ref<HTMLInputElement>();
function clearSearch(){search.value='';searchInput.value?.focus();}
const visit=readFragment(location.hash);
const sections=computed(()=>artifact.value?publicSections(artifact.value,language.value):[]);
const hits=computed(()=>sections.value.filter(s=>[s.title,...s.blocks.map(b=>b.kind==='text'?b.text:b.kind==='code'?b.title+' '+b.text:b.headers.join(' ')+' '+b.rows.flat().join(' '))].join(' ').toLocaleLowerCase().includes(search.value.toLocaleLowerCase())));
function navigate(section:string) { history.replaceState(null,'',sectionFragment(visit,section)); document.getElementById(section)?.scrollIntoView?.({block:'start'}); }
const errorMessage=computed(()=>{
  const en=language.value==='en';const reason=failure.value?.reason;
  const reasons:Record<string,[string,string]>={expired:['授权已到期','Access has expired'],revoked:['授权已撤销','Access was revoked'],responsibility_changed:['发布责任资格已变化','Publication responsibility changed'],policy_changed:['共享策略已变化','Sharing policy changed'],publication_disabled:['发布已停用','Publication was disabled']};
  if(reason&&reasons[reason])return reasons[reason][en?1:0];
  return failure.value?.code==='export_too_large'?(en?'Escaped offline file exceeds the generation limit':'离线文件超过生成上限'):failure.value?.code==='export_failed'?(en?'Offline file could not be generated':'离线文件无法生成'):failure.value?.code==='capacity'?(en?'Access capacity is full':'访问容量已满'):failure.value?.code==='service_unavailable'?(en?'Service is temporarily unavailable':'服务暂不可用'):(en?'Shared content is unavailable':'共享内容不可用');
});
async function reload(download=false) {
  const own=++generation; pending.value=true; loaded.value=undefined;downloadAllowed.value=false;failure.value=undefined;version.value='';copied.value=false;copyFailed.value=false;
  const result=await readPublic(location.origin,location.pathname.split('/')[2]??'',visit.key,download);
  if(own!==generation)return;
  pending.value=false;
  if(!result.ok){failure.value=result;return;}
  loaded.value=result.artifact;version.value=result.version;downloadAllowed.value=result.downloadAllowed;
  if(download){
    try {
      const html=renderPublicArtifactHtml(result.artifact);
      const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
      try { const link=document.createElement('a');link.href=url;link.download='apicc-publication.html';link.click(); }
      finally { URL.revokeObjectURL(url); }
    } catch(error) {failure.value={ok:false,code:error instanceof Error&&error.message==='public-html-size-limit'?'export_too_large':'export_failed'};return;}
  }
  await nextTick();document.getElementById(visit.section)?.scrollIntoView?.({block:'start'});
}
async function copy(text:string){copied.value=false;copyFailed.value=false;try{await navigator.clipboard.writeText(text);copied.value=true;}catch{copyFailed.value=true;}}
onMounted(()=>{if(!props.artifact)void reload();});
</script>
<template>
  <div class="reader">
    <aside>
      <div class="tools"><strong>{{ language==='en'?'Read-only publication':'只读发布内容' }}</strong><div class="languages"><button :aria-pressed="language==='zh-CN'" data-language="zh-CN" @click="language='zh-CN'">中文</button><button :aria-pressed="language==='en'" data-language="en" @click="language='en'">English</button></div><label for="publication-search">{{ language==='en'?'Search':'搜索' }}</label><span class="search-field"><input id="publication-search" ref="searchInput" v-model="search" type="search" :placeholder="language==='en'?'Search publication':'搜索发布内容'"><button v-if="search" type="button" data-action="clear-search" :aria-label="language==='en'?'Clear search':'清除搜索'" @click="clearSearch">×</button></span></div>
      <nav :aria-label="language==='en'?'Contents':'目录'"><a v-for="section in hits" :key="section.id" href="#" @click.prevent="navigate(section.id)">{{section.title}}</a></nav>
    </aside>
    <main>
      <div class="actions"><button data-action="refresh" @click="reload()">{{language==='en'?'Refresh':'刷新'}}</button><button v-if="downloadAllowed" data-action="download" @click="reload(true)">{{language==='en'?'Download offline HTML':'下载离线 HTML'}}</button></div>
      <p v-if="pending" role="status">{{language==='en'?'Loading…':'正在读取…'}}</p>
      <div v-if="failure" role="alert"><h2>{{errorMessage}}</h2><p v-if="failure.code==='export_too_large'||failure.code==='export_failed'">{{language==='en'?'Freshly authorized facts are retained below. No file was downloaded. Contact the person who shared it to reduce the publication scope, or retry export in a supported browser.':'下方保留本次重新授权的发布事实，未下载文件。请联系分享者缩小发布范围，或在支持导出的浏览器中重试。'}}</p><p v-else>{{failure.code==='capacity'||failure.code==='service_unavailable'?(language==='en'?'Retry later.':'请稍后重试。'):(language==='en'?'Contact the person who shared this link for a new authorized link.':'请联系分享者获取新的有效授权链接。')}}</p></div>
      <p v-if="copied" role="status">{{language==='en'?'Copied':'已复制'}}</p>
      <p v-if="copyFailed" role="status">{{language==='en'?'Copy is unavailable; select the snippet manually.':'复制不可用，请手动选择片段'}}</p>
      <template v-if="artifact">
        <h1>{{artifact.title}}</h1><p v-if="version">{{language==='en'?'Publication version':'发布版本'}}: {{version}}</p>
        <p>{{language==='en'?'Content fingerprint':'内容指纹'}}: <code>{{artifact.source.digest.slice(0,12)}}</code></p>
        <details><summary>{{language==='en'?'Full fingerprint':'完整指纹'}}</summary><code>{{artifact.source.digest}}</code></details>
        <p v-if="search" role="status">{{language==='en'?'Matching sections':'命中章节'}}: {{hits.length}}</p>
        <p v-if="search && !hits.length" data-testid="search-empty" class="empty-state">{{language==='en'?'No matching sections. Clear the search or try another keyword.':'没有匹配章节。请清除搜索或更换关键词。'}}</p>
        <section v-for="section in hits" :id="section.id" :key="section.id">
          <h2>{{section.title}}</h2>
          <template v-for="(block,index) in section.blocks" :key="index">
            <p v-if="block.kind==='text'">{{block.text}}</p>
            <div v-else-if="block.kind==='table'" class="table-scroll"><table><thead><tr><th v-for="(header,i) in block.headers" :key="i">{{header}}</th></tr></thead><tbody><tr v-for="(row,j) in block.rows" :key="j"><td v-for="(cell,k) in row" :key="k">{{cell}}</td></tr></tbody></table></div>
            <div v-else class="contract"><h3>{{block.title}}</h3><button data-action="copy" @click="copy(block.text)">{{language==='en'?'Copy snippet':'复制片段'}}</button><pre>{{block.text}}</pre></div>
          </template>
        </section>
        <details><summary>{{language==='en'?'Raw safe data':'原始安全数据'}}</summary><pre>{{JSON.stringify(artifact,null,2)}}</pre></details>
      </template>
    </main>
  </div>
</template>
<style>
:root{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#172b42;background:#f4f7fb;font-synthesis:none}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{border:1px solid #adc1d7;background:white;border-radius:6px;padding:7px 12px;cursor:pointer}button:hover{background:#edf4fd}button:disabled{cursor:wait;opacity:.65}.reader{display:grid;grid-template-columns:280px minmax(0,1fr);height:100dvh}aside{display:flex;flex-direction:column;min-height:0;border-right:1px solid #cad6e5;background:#fff}.tools{padding:22px 18px;flex:none;border-bottom:1px solid #dae3ef}.languages{display:flex;gap:8px;margin:14px 0}label{display:grid;gap:8px}input{width:100%;min-width:0;border:1px solid #a7bbd1;padding:9px;border-radius:6px}nav{overflow:auto;min-height:0;padding:12px}nav a{display:block;padding:10px 8px;color:#205e9e;text-decoration:none;overflow-wrap:anywhere;border-radius:6px}nav a:hover{background:#edf4fd}main{overflow:auto;padding:28px clamp(18px,4vw,64px);min-width:0}h1{font-size:26px;line-height:1.5;overflow-wrap:anywhere}h2{font-size:20px}h3{font-size:16px}p{line-height:1.7;overflow-wrap:anywhere;white-space:pre-wrap}section{background:white;padding:20px;margin:18px 0;border:1px solid #d6e0ec;border-radius:9px;scroll-margin-top:20px}.table-scroll{overflow:auto;max-height:28rem;margin:12px 0}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #dce4ef;text-align:left;min-width:7rem;max-width:34rem;overflow-wrap:anywhere}th{white-space:nowrap;background:#f1f5fb;position:sticky;top:0}pre{overflow:auto;max-height:26rem;white-space:pre;line-height:1.5;background:#f0f4f9;padding:14px}details{margin:14px 0;overflow-wrap:anywhere}summary{cursor:pointer}code{overflow-wrap:anywhere}@media(max-width:700px){.reader{grid-template-columns:210px minmax(0,1fr)}main{padding:16px}section{padding:12px}}

:root{font-size:14px;line-height:1.6}button[aria-pressed=true]{color:#175bb8;border-color:#7da6e1;background:#eaf2ff}.actions{display:flex;gap:8px;flex-wrap:wrap}.search-field{position:relative;display:block}.search-field input{padding-right:32px}.search-field input::-webkit-search-cancel-button{display:none}.search-field button{position:absolute;right:2px;top:50%;transform:translateY(-50%);padding:2px 6px;border:0;background:transparent}.empty-state,[role=alert]{border:1px solid #d6e0ec;border-radius:8px;padding:16px;background:white}section{box-shadow:0 2px 8px #20345405}th,td{font-variant-numeric:tabular-nums}:focus-visible{outline:2px solid #2875db;outline-offset:3px}@media(max-width:600px){.reader{grid-template-columns:160px minmax(0,1fr)}.tools{padding:12px}.languages{gap:4px}.languages button{padding:6px}.tools strong{font-size:13px}}@media(max-height:400px){.tools{padding:8px 12px}.languages{margin:6px 0}.tools label{gap:2px}nav{padding:4px 10px}}
</style>
