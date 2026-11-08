import {createApp,ref,computed,h} from 'vue';
import {ConfigProvider,theme} from 'ant-design-vue';
import {initI18n} from '@desktop/i18n/bridge';
import {themePreference,resolveTheme} from '@desktop/theme';
import '@desktop/styles/theme.css';
import ThemeLanguageToggle from '@desktop/components/ThemeLanguageToggle.vue';
import OnlineSchedulesPanel from '@desktop/components/online/OnlineSchedulesPanel.vue';
import OnlineNotificationsPanel from '@desktop/components/online/OnlineNotificationsPanel.vue';
import OnlineExecutionPanel from '@desktop/components/online/OnlineExecutionPanel.vue';
import OnlineStressPanel from '@desktop/components/online/OnlineStressPanel.vue';
import CollaborationPanel from '@desktop/components/online/CollaborationPanel.vue';
import {createOnlineExecutionStore} from '@desktop/stores/onlineExecution';
import {createOnlineSchedulesStore} from '@desktop/stores/onlineSchedules';
import {createCollaborationStore} from '@desktop/stores/collaboration';
import seed from './seed.json';
localStorage.setItem('apicc.locale','zh-CN');
const {i18n}=initI18n(),pane=ref('schedules'),empty=ref(false);
const execution=createOnlineExecutionStore({onlineExecution:async()=>{throw Error('Fixture denies execution');}});
execution.activate(seed.context);execution.project=seed.project;execution.saved=JSON.stringify(seed.project);execution.agents=seed.agents;execution.visible=true;execution.location={kind:'agent',agentId:'5'};execution.connection='connected';
execution.jobs=[{jobId:'78',executionId:'79',agentId:'5',state:'running',cancelState:'requested',executionReleased:false,canCancel:true,view:'active-status',scope:seed.context.scope}];
const schedules=createOnlineSchedulesStore({onlineScheduling:async input=>{
 switch(input.operation){
  case 'options':return seed.options;
  case 'list':return {items:[seed.schedule],nextBeforeId:null};
  case 'detail':return seed.schedule;
  case 'history':return seed.history;
  case 'notificationHistory':return seed.notificationHistory;
  case 'notifications':return empty.value?{items:[],nextBeforeId:null}:seed.notifications;
  case 'markNotificationRead':return {id:input.id,read:true};
  default:throw Error('Fixture denies mutations and execution');
 }
}});
schedules.activate(seed.context);
const collab=createCollaborationStore({onlineCollaboration:async input=>{
 switch(input.operation){case 'activate':case 'cancel-preview':return {stage:'idle'};case 'access':return seed.access;case 'publications':return seed.publications;case 'grants':return seed.grants;case 'history':return {stage:'history',page:{items:seed.sharedHistory,nextCursor:null}};case 'read-history':return {stage:'history-body',history:{...input.input,artifact:seed.local.artifact}};default:throw Error('Fixture denies upload, publication and grants');}
}});
async function load(p:string){pane.value=p;if(p==='schedules'){await schedules.load(seed.context);}if(p==='collaboration'){await collab.activate(seed.context);collab.preview=seed.local;await collab.loadHistory();await collab.loadPublications();await collab.loadGrants('41');}}
const antdTheme=computed(()=>({token:{colorPrimary:'#315fe9',borderRadius:6,controlHeight:32,fontSize:13},algorithm:resolveTheme(themePreference.value,matchMedia('(prefers-color-scheme: dark)').matches)==='dark'?theme.darkAlgorithm:theme.defaultAlgorithm}));
document.head.insertAdjacentHTML('beforeend','<style>html,body,#app{height:100%;margin:0;overflow:hidden}#app{display:flex;flex-direction:column;overflow:hidden}.fixture-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 16px;background:var(--panel);font-size:12px;border-bottom:1px solid var(--border)}.fixture-bar button:not(.ant-btn){border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);padding:5px 10px}.fixture-body{flex:1;min-height:0;overflow:auto}</style>');
createApp({setup:()=>()=>h(ConfigProvider,{theme:antdTheme.value},()=>[h('div',{class:'fixture-bar'},[h('span','P3f · 实际组件 / 合成数据 / 无后台'),...['schedules','notifications','execution','stress','collaboration'].map(p=>h('button',{onClick:()=>load(p)},p)),h('button',{onClick:async()=>{empty.value=!empty.value;await schedules.loadNotifications();}},'Empty notifications'),h('button',{onClick:()=>{if(schedules.selected)schedules.refreshCandidate={preparation:seed.preparation,id:schedules.selected.id,version:schedules.selected.version};}},'Show snapshot diff'),h(ThemeLanguageToggle)]),h('div',{class:'fixture-body'},[
 pane.value==='schedules'?h(OnlineSchedulesPanel,{execution,schedules}):pane.value==='notifications'?h(OnlineNotificationsPanel,{schedules}):pane.value==='execution'?h(OnlineExecutionPanel,{execution}):pane.value==='stress'?h(OnlineStressPanel,{execution}):h(CollaborationPanel,{collaboration:collab,saved:{revision:'1',manifestHash:'a'.repeat(64)}})
])])}).use(i18n).mount('#app');
void load('schedules');
