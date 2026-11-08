import {createApp,ref,computed,h} from 'vue';
import {ConfigProvider,theme} from 'ant-design-vue';
import {initI18n} from '@desktop/i18n/bridge';
import {themePreference,resolveTheme} from '@desktop/theme';
import '@desktop/styles/theme.css';
import ThemeLanguageToggle from '@desktop/components/ThemeLanguageToggle.vue';
import SyncPanel from '@desktop/components/sync/SyncPanel.vue';
import {createSynchronizationStore} from '@desktop/stores/synchronization';
import {defaultSyncPolicyValues,SyncHistoryEntrySchema,SyncFixedDetailSchema} from '../../../packages/core/src/sync/shared';
import {candidateView,source,id,localScope,onlineScope,policyView,scheduleView} from './seed';
localStorage.setItem('apicc.locale','zh-CN');
const {i18n}=initI18n(), mode=ref('local'), readonly=ref(false);
const candidate=candidateView().candidate;
candidate.changes[0].label='宠物接口描述 · Pet description';
candidate.changes[0].summaries={baseline:{kind:'scalar',value:'返回可领养宠物列表 / List adoptable pets',truncated:false},current:{kind:'scalar',value:'返回可领养宠物列表，包含地区筛选 / With regional filters',truncated:false},source:{kind:'scalar',value:'返回可领养宠物列表，支持游标分页 / With cursor pagination',truncated:false}};
const content={digest:'a'.repeat(64),bytes:12,contentType:'application/vnd.apicc.sync-files+json'};
const historyEntry=SyncHistoryEntrySchema.parse({formatVersion:1,id:id(10),sourceId:source.id,projectId:id(1),intentId:id(8),operationKind:'apply',actor:{id:'7',name:'合成成员 / Synthetic member'},createdAtMs:1793980800123,beforeStamp:candidate.stamp,afterStamp:candidate.stamp,upstream:candidate.upstream,before:{definitionRevision:'a'.repeat(64),manifestDigest:'b'.repeat(64)},after:{definitionRevision:'c'.repeat(64),manifestDigest:'d'.repeat(64)},rollback:{beforeContent:content,afterContent:content},integritySha256:'e'.repeat(64)});
const events:string[]=[];
const store=createSynchronizationStore({synchronization:async input=>{
  events.push(input.operation);
  switch(input.operation){
    case 'activate': case 'deactivate': return null;
    case 'sources': return [source];
    case 'history': return [historyEntry];
    case 'materials': return [{refId:'owned-auth',kind:'credential',status:'unavailable',version:'2'}];
    case 'settings': return {revision:'1',maxRedirects:5,policy:defaultSyncPolicyValues,git:'missing',ssh:'missing'};
    case 'policy': return policyView();
    case 'access': return {accountEnabled:true,member:true,workspaceRole:'EDITOR',projectOverride:null,overrideState:'inherited',effectiveRole:'EDITOR',capabilities:['sync.manage','sync.check','sync.apply','credential.manage'],accessRevision:1,membershipEpoch:1,responsibilityEpoch:1,reasonCode:null};
    case 'schedule': return scheduleView();
    case 'checks': return {formatVersion:1,sourceId:source.id,current:null,latestAttempt:null,latestSuccess:null};
    case 'check': return {candidate,applicable:true,reasonCode:null};
    case 'detail': {const text=JSON.stringify({openapi:'3.1.0',info:{title:'Synthetic pets API',description:'Long preserved business content '+ 'abcdefghij'.repeat(120)},paths:{'/pets':{get:{description:input.request.side+' document'}}}},null,2);return SyncFixedDetailSchema.parse({formatVersion:1,candidateId:candidate.id,candidateDigest:candidate.candidateDigest,entityId:candidate.changes[0].entityId,entityKind:candidate.changes[0].entityKind,changeId:candidate.changes[0].changeId,side:input.request.side,kind:'document',assetPath:candidate.changes[0].path,fieldPath:'/metadata/description',contentType:'application/vnd.apicc.contract+yaml',bytes:new TextEncoder().encode(text).length,sha256:'a'.repeat(64),text});}
    default: throw Error('Fixture does not permit mutations');
  }
}},undefined,null);
async function load(kind:string){mode.value=kind;readonly.value=kind==='readonly';store.activate(kind==='online'?onlineScope:localScope());await store.load();store.candidate={candidate,applicable:true,reasonCode:null};}
const antdTheme=computed(()=>({token:{colorPrimary:'#315fe9',borderRadius:6,controlHeight:32,fontSize:13},algorithm:resolveTheme(themePreference.value,matchMedia('(prefers-color-scheme: dark)').matches)==='dark'?theme.darkAlgorithm:theme.defaultAlgorithm}));
document.head.insertAdjacentHTML('beforeend','<style>html,body,#app{height:100%;margin:0;overflow:hidden}#app{display:flex;flex-direction:column;overflow:hidden}.fixture-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 16px;background:var(--panel);font-size:12px;border-bottom:1px solid var(--border)}.fixture-bar button:not(.ant-btn){border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);padding:5px 10px}.fixture-body{flex:1;min-height:0}</style>');
createApp({setup:()=>()=>h(ConfigProvider,{theme:antdTheme.value},()=>[h('div',{class:'fixture-bar'},[h('span','P3e · 实际组件 / 合成数据 · 无后台 / 无 IPC'),...['local','online','readonly'].map(p=>h('button',{onClick:()=>load(p)},p)),h(ThemeLanguageToggle)]),h('div',{class:'fixture-body'},[h(SyncPanel,{store,readOnly:readonly.value,modules:[{id:source.moduleId,name:'宠物服务 / Pets'}]})])])}).use(i18n).mount('#app');
void load('local');
