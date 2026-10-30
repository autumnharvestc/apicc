import { reactive } from 'vue';
import type { AdminClient } from '../api/client.js';
import { AdminApiError } from '../api/client.js';
import { z } from 'zod';
import { createSchedulingApi, type SchedulePolicyView,type NotificationChannel,type ScheduleGrantOptions } from '../api/scheduling.js';
import { wireValue } from '../api/agents.js';
import type { SchedulePolicyPatch } from '@apicc/execution/contract';
import {defaultNotificationDeployment,ScheduleGrantsSchema,type NotificationLimits,type SchedulerControl} from '@apicc/execution/contract';
const limitKeys=['requestTimeoutMs','maxAttempts','retryMinMs','retryMaxMs','jitterRatio','deliveryTtlMs','maxPayloadBytes','maxResponseBytes'] as const;
export function channelDisplayValue(key:string,value:number){return value/(key.endsWith('Ms')?1000:key.endsWith('Bytes')?1024:key.endsWith('Ratio')?0.01:1);}
type ChannelDraft={id?:string;version:string;name:string;url:string;hmacSecret:string;enabled:boolean;rotationConfirmed:boolean;limits:Record<keyof NotificationLimits,string>};
function channelDraft(row?:NotificationChannel):ChannelDraft{return {id:row?.id,version:row?.version??'0',name:row?.name??'',url:'',hmacSecret:'',enabled:row?.enabled??false,rotationConfirmed:false,limits:Object.fromEntries(limitKeys.map(key=>[key,String(channelDisplayValue(key,(row?.limits??defaultNotificationDeployment)[key]))])) as ChannelDraft['limits']};}
export function createSchedulingStore({client}:{client:AdminClient}){
  const api=createSchedulingApi(client);
  let epoch=0,requestId=0,actionId=0;
  const state=reactive({grants:null as z.infer<typeof ScheduleGrantsSchema>|null,grantDraft:[] as string[],grantOptions:null as ScheduleGrantOptions|null,control:null as SchedulerControl|null,controlModeDraft:'embedded' as 'embedded'|'disabled',policy:null as SchedulePolicyView|null,channels:[] as NotificationChannel[],channelsReady:false,channelDraft:null as ChannelDraft|null,deleteChannelTarget:null as NotificationChannel|null,error:'',errorFields:[] as string[],loading:false,busy:false,conflict:false,scope:'',policyDraft:{} as Record<string,string>,resetKeys:[] as (keyof SchedulePolicyPatch)[]});
  function fail(error:unknown){state.errorFields=[];state.conflict=error instanceof AdminApiError&&error.status===409;state.error=error instanceof AdminApiError?error.code:error instanceof z.ZodError?'validation_failed':'protocol_error';if(error instanceof z.ZodError)state.errorFields=[...new Set(error.issues.map(issue=>String(issue.path.at(-1)??'')).filter(Boolean))];}
  function invalidGrantIds(){const eligible=new Set(state.grantOptions?.items.filter(row=>row.eligible).map(row=>row.userId)??[]);return state.grantDraft.filter(id=>!eligible.has(id));}
  return Object.assign(state,{
    reset(){epoch++;requestId++;actionId++;Object.assign(state,{grants:null,grantDraft:[],grantOptions:null,control:null,controlModeDraft:'embedded',policy:null,channels:[],channelsReady:false,channelDraft:null,deleteChannelTarget:null,error:'',errorFields:[],loading:false,busy:false,conflict:false,scope:'',policyDraft:{},resetKeys:[]});},
    async loadGrantOptions(ws:string,project:string,preserveDraft=false){const keep=preserveDraft&&state.scope===`grants/${ws}/${project}`;const session=epoch,ticket=++requestId;actionId++;state.scope=`grants/${ws}/${project}`;state.grants=null;state.grantOptions=null;if(!keep)state.grantDraft=[];state.error='';state.conflict=false;state.busy=false;const current=()=>epoch===session&&requestId===ticket;
      try{const [options,grants]=await Promise.all([api.grantOptions(ws,project),api.grants(ws,project)]);if(current()){state.grantOptions=options;state.grants=grants;if(!keep)state.grantDraft=[...grants.userIds];}}catch(error){if(current())fail(error);}
    },
    invalidGrantIds,
    clearInvalidGrants(){const invalid=new Set(invalidGrantIds());state.grantDraft=state.grantDraft.filter(id=>!invalid.has(id));},
    async saveGrants(ws:string,project:string){
      if(!state.grants||!state.grantOptions||state.busy||state.conflict||state.scope!==`grants/${ws}/${project}`||state.error==='schedule-grant-ineligible')return false;
      if(invalidGrantIds().length){state.error='schedule-grant-ineligible';return false;}
      const session=epoch,ticket=++actionId;const current=()=>epoch===session&&ticket===actionId&&state.scope===`grants/${ws}/${project}`;state.busy=true;state.error='';
      try{const grants=await api.saveGrants(ws,project,{expectedVersion:state.grants.version,userIds:[...state.grantDraft]});if(!current())return false;state.grants=grants;state.grantDraft=[...grants.userIds];return true;}catch(error){if(current())fail(error);return false;}finally{if(current())state.busy=false;}
    },
    async loadControl(preserveDraft=false){const session=epoch,ticket=++requestId;actionId++;state.scope='control';state.control=null;state.error='';state.conflict=false;state.busy=false;state.channelDraft=null;state.channels=[];state.channelsReady=false;state.policy=null;const current=()=>epoch===session&&ticket===requestId;
      try{const control=await api.control();if(current()){state.control=control;if(!preserveDraft)state.controlModeDraft=control.mode;}}catch(error){if(current())fail(error);}
    },
    async saveControl(){if(!state.control||state.busy||state.conflict||state.scope!=='control')return false;const session=epoch,ticket=++actionId;const current=()=>epoch===session&&ticket===actionId&&state.scope==='control';state.busy=true;state.error='';
      try{const control=await api.saveControl({mode:state.controlModeDraft,expectedVersion:state.control.version});if(!current())return false;state.control=control;return true;}catch(error){if(current())fail(error);return false;}finally{if(current())state.busy=false;}
    },
    async loadChannels(ws:string,preserveDraft=false){
      preserveDraft=preserveDraft&&state.scope===`channels/${ws}`;
      const session=epoch,ticket=++requestId;actionId++;state.scope=`channels/${ws}`;state.busy=false;state.conflict=false;state.channels=[];state.channelsReady=false;state.deleteChannelTarget=null;state.error='';state.errorFields=[];
      if(!preserveDraft)state.channelDraft=null;const current=()=>epoch===session&&requestId===ticket;
      try{const rows=(await api.channels(ws)).items;if(current()){state.channels=rows;state.channelsReady=true;if(state.channelDraft?.id){const latest=rows.find(row=>row.id===state.channelDraft!.id);if(latest){state.channelDraft.version=latest.version;state.channelDraft.rotationConfirmed=false;}else{state.error='channel_not_found';state.conflict=true;}}}}catch(error){if(current())fail(error);}
    },
    editChannel(row?:NotificationChannel){if(state.busy)return;state.channelDraft=channelDraft(row);state.error='';state.errorFields=[];},
    async saveChannel(ws:string){
      const draft=state.channelDraft;if(!draft||!state.channelsReady||state.busy||state.conflict||state.scope!==`channels/${ws}`)return false;
      if(draft.id&&(draft.url||draft.hmacSecret)&&!draft.rotationConfirmed){state.error='rotation_confirmation_required';return false;}
      const session=epoch,ticket=++actionId;const current=()=>epoch===session&&ticket===actionId&&state.scope===`channels/${ws}`;state.busy=true;state.error='';state.errorFields=[];
      const limits=Object.fromEntries(limitKeys.map(key=>[key,wireValue(key.endsWith('Bytes')?'bodyPreviewBytes':key,draft.limits[key])])) as NotificationLimits;
      try{
        const row=draft.id?await api.updateChannel(ws,draft.id,{expectedVersion:draft.version,name:draft.name,enabled:draft.enabled,limits,...(draft.url?{url:draft.url}:{}),...(draft.hmacSecret?{hmacSecret:draft.hmacSecret}:{})}):await api.createChannel(ws,{expectedVersion:'0',name:draft.name,url:draft.url,hmacSecret:draft.hmacSecret,enabled:draft.enabled,limits});
        if(!current())return false;state.channels=[...state.channels.filter(old=>old.id!==row.id),row];state.channelDraft=null;return true;
      }catch(error){if(current())fail(error);return false;}finally{if(current())state.busy=false;}
    },
    async deleteChannel(ws:string){const target=state.deleteChannelTarget;if(!target||state.busy||state.conflict||state.scope!==`channels/${ws}`)return false;const session=epoch,ticket=++actionId;const current=()=>epoch===session&&ticket===actionId&&state.scope===`channels/${ws}`;state.busy=true;
      try{await api.deleteChannel(ws,target.id,target.version);if(!current())return false;state.channels=state.channels.filter(row=>row.id!==target.id);state.deleteChannelTarget=null;if(state.channelDraft?.id===target.id)state.channelDraft=null;return true;}catch(error){if(current())fail(error);return false;}finally{if(current())state.busy=false;}
    },
    async loadPolicy(ws:string,project?:string,preserveDraft=false){
      preserveDraft=preserveDraft&&state.scope===`${ws}/${project??''}`;
      const session=epoch,ticket=++requestId;actionId++;state.busy=false;state.channelDraft=null;state.deleteChannelTarget=null;state.channelsReady=false;state.channels=[];state.policy=null;state.error='';state.errorFields=[];state.conflict=false;state.loading=true;state.scope=`${ws}/${project??''}`;
      if(!preserveDraft){state.policyDraft={};state.resetKeys=[];}
      const current=()=>epoch===session&&requestId===ticket;
      try{const policy=await api.policy(ws,project);if(current())state.policy=policy;}catch(error){if(current())fail(error);}finally{if(current())state.loading=false;}
    },
    inherit(key:keyof SchedulePolicyPatch){if(state.busy)return;delete state.policyDraft[key];state.resetKeys=[...new Set([...state.resetKeys,key])];},
    async savePolicy(ws:string,project?:string){
      if(!state.policy||state.busy||state.conflict||state.scope!==`${ws}/${project??''}`)return false;
      const session=epoch,ticket=++actionId,scope=state.scope;const current=()=>epoch===session&&ticket===actionId&&state.scope===scope;state.busy=true;state.error='';state.errorFields=[];
      const patch:Record<string,unknown>={};for(const [key,value] of Object.entries(state.policyDraft))if(value.trim()!=='')patch[key]=['misfire','overlap'].includes(key)?value:wireValue(key,value);
      try{const policy=await api.savePolicy(ws,project,{expectedVersion:state.policy.version,policy:patch,resetKeys:state.resetKeys});if(!current())return false;state.policy=policy;state.policyDraft={};state.resetKeys=[];return true;}catch(error){if(current())fail(error);return false;}finally{if(current())state.busy=false;}
    },
  });
}
export type SchedulingStore=ReturnType<typeof createSchedulingStore>;
