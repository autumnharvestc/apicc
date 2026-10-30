import { readFileSync } from 'node:fs';
import { createAdminClient } from '../../src/api/client.js';
import { createSchedulingStore } from '../../src/stores/scheduling.js';
import { createAdminI18n } from '../../src/i18n/index.js';
export const actualPolicy=()=>JSON.parse(readFileSync('../../server/src/test/resources/scheduling/t7-project-policy.json','utf8'));
export const actualChannels=()=>JSON.parse(readFileSync('../../server/src/test/resources/notifications/channels-canonical-origins.json','utf8'));
export const actualChannelMetadata=(enabled:boolean,readable:boolean,supported:boolean)=>JSON.parse(readFileSync(`../../server/src/test/resources/scheduling/t7-channel-${enabled}-${readable}-${supported}.json`,'utf8'));
export const actualGrantOptions=()=>JSON.parse(readFileSync('../../server/src/test/resources/scheduling/t7-grant-options.json','utf8'));
export const actualGrants=()=>JSON.parse(readFileSync('../../server/src/test/resources/scheduling/t7-project-grants.json','utf8'));
export const jsonResponse=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
export type Call={path:string;method:string;body:any};
export function schedulingHarness(handler:(call:Call)=>Response|Promise<Response>,locale:'zh-CN'|'en'='zh-CN'){
  const calls:Call[]=[];
  const client=createAdminClient({token:'synthetic-session',fetch:async(input,init)=>{
    const call={path:String(input),method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):undefined};calls.push(call);return handler(call);
  }});
  localStorage.setItem('apicc.admin.locale',locale);const {i18n}=createAdminI18n();
  return {client,calls,scheduling:createSchedulingStore({client}),i18n};
}
export async function mountSchedulingRoute(path:string,handler:(call:Call)=>Response|Promise<Response>,opts:{locale?:'zh-CN'|'en';workspaceRole?:'OWNER'|'EDITOR';platform?:boolean}={}){
  const [{mount,flushPromises},{createSessionStore},{createWorkspacesStore},{createUsersStore},{createOrgStore},{createAppRouter},{default:App}]=await Promise.all([import('@vue/test-utils'),import('../../src/stores/session.js'),import('../../src/stores/workspaces.js'),import('../../src/stores/users.js'),import('../../src/stores/org.js'),import('../../src/router/index.js'),import('../../src/App.vue')]);
  Object.defineProperty(window,'matchMedia',{writable:true,value:(query:string)=>({matches:false,media:query,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})});
  const h=schedulingHarness(call=>{
    if(call.path.endsWith('/me'))return jsonResponse({id:'1',username:'user',displayName:'User',role:opts.platform?'SUPERADMIN':'USER'});
    if(call.path.endsWith('/workspaces/1'))return jsonResponse({id:'1',name:'团队',myRole:opts.workspaceRole??'OWNER',memberCount:1});
    if(call.path.endsWith('/groups'))return jsonResponse([{id:'1',name:'默认分组',isDefault:true,createdAt:'2026-10-29T00:00:00Z'}]);
    if(call.path.endsWith('/projects'))return jsonResponse([{id:'2',groupId:'1',name:'项目管理很长的名称用于悬停查看',createdAt:'2026-10-29T00:00:00Z'}]);
    if(call.path.endsWith('/workspaces'))return jsonResponse([]);
    return handler(call);
  },opts.locale);
  localStorage.setItem('apicc.admin.token','synthetic-session');const session=createSessionStore({client:h.client});await session.initialize();const workspaces=createWorkspacesStore({client:h.client});await workspaces.select('1');
  const router=createAppRouter({client:h.client,session,workspaces,users:createUsersStore({client:h.client}),org:createOrgStore({client:h.client}),scheduling:h.scheduling});await router.push(path);await router.isReady();
  const wrapper=mount(App,{attachTo:document.body,global:{plugins:[router,h.i18n]}});await flushPromises();return {...h,wrapper,router,session};
}
