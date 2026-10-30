import { describe, expect, it } from 'vitest';
import { SchedulePolicyUpdateSchema,SchedulePolicyViewSchema,ScheduleGrantOptionsSchema } from '../src/contract/scheduling.js';
import {NotificationChannelSchema} from '../src/contract/scheduling.js';
import {readFileSync} from 'node:fs';
import {createSchedulingClient} from '../src/client/scheduling.js';

describe('admin scheduling updates',()=>{
  it('accepts optional reset keys and deduplicates them while old updates remain valid',()=>{
    const parsed=SchedulePolicyUpdateSchema.safeParse({expectedVersion:'0',policy:{},resetKeys:['minIntervalMs','minIntervalMs']});
    expect(parsed.success).toBe(true);if(parsed.success)expect((parsed.data as {resetKeys?:string[]}).resetKeys).toEqual(['minIntervalMs']);
    expect(SchedulePolicyUpdateSchema.safeParse({expectedVersion:'0',policy:{minIntervalMs:120000}}).success).toBe(true);
  });
  it.each([{resetKeys:['unknown'],policy:{}},{resetKeys:['minIntervalMs'],policy:{minIntervalMs:120000}}])('rejects unknown or simultaneous patch/reset $resetKeys',input=>{
    expect(SchedulePolicyUpdateSchema.safeParse({expectedVersion:'0',...input}).success).toBe(false);
  });
  it.each(['missing-source','extra-source','missing-effective'])('rejects incomplete policy administration facts %s',kind=>{
    const row=JSON.parse(readFileSync(new URL('../../../server/src/test/resources/scheduling/t7-project-policy.json',import.meta.url),'utf8'));
    if(kind==='missing-source')delete row.source.minIntervalMs;if(kind==='extra-source')row.source.unknown='default';if(kind==='missing-effective')delete row.effective.minIntervalMs;
    expect(SchedulePolicyViewSchema.safeParse(row).success).toBe(false);
  });
});
describe('project administrator grant options client',()=>{
  it('reads the actual project-authorized metadata with the authenticated project route',async()=>{
    const metadata=JSON.parse(readFileSync(new URL('../../../server/src/test/resources/scheduling/t7-grant-options.json',import.meta.url),'utf8'));
    const calls:{url:string;init?:RequestInit}[]=[];
    const client=createSchedulingClient({baseUrl:'https://control.test/api/v1',token:()=> 'synthetic-session',fetch:async(url,init)=>{calls.push({url:String(url),init});return Response.json(metadata);}});
    const result=await client.grantOptions({workspaceId:'1',projectId:'2'},new AbortController().signal);
    expect(result).toEqual(metadata);expect(calls).toHaveLength(1);expect(calls[0]?.url).toBe('https://control.test/api/v1/workspaces/1/projects/2/schedule-grants/options');expect(calls[0]?.init).toMatchObject({method:'GET',redirect:'error',cache:'no-store',headers:{authorization:'Bearer synthetic-session'}});
  });
  it.each([
    {effectiveRole:'VIEWER',eligible:true,reasonCode:null},
    {effectiveRole:'EDITOR',eligible:true,reasonCode:'account-disabled'},
    {effectiveRole:'EDITOR',eligible:false,reasonCode:null},
    {effectiveRole:'EDITOR',eligible:false,reasonCode:'editor-required'},
    {effectiveRole:'VIEWER',eligible:false,reasonCode:'project-access-denied'},
    {effectiveRole:null,eligible:false,reasonCode:'editor-required'},
  ])('rejects inconsistent eligibility $effectiveRole/$eligible/$reasonCode',patch=>{
    const metadata=JSON.parse(readFileSync(new URL('../../../server/src/test/resources/scheduling/t7-grant-options.json',import.meta.url),'utf8'));metadata.items=[{...metadata.items[0],...patch}];expect(ScheduleGrantOptionsSchema.safeParse(metadata).success).toBe(false);
  });
  it('rejects duplicate member identity in options',()=>{
    const metadata=JSON.parse(readFileSync(new URL('../../../server/src/test/resources/scheduling/t7-grant-options.json',import.meta.url),'utf8'));metadata.items.push(metadata.items[0]);expect(ScheduleGrantOptionsSchema.safeParse(metadata).success).toBe(false);
  });
});
describe('actual independent channel metadata',()=>{
  it.each([[true,true,true],[true,true,false],[true,false,true],[true,false,false],[false,true,true],[false,true,false],[false,false,true],[false,false,false]])('accepts actual key/source metadata enabled=%s readable=%s supported=%s',(enabled,readable,supported)=>{
    const row=JSON.parse(readFileSync(new URL(`../../../server/src/test/resources/scheduling/t7-channel-${enabled}-${readable}-${supported}.json`,import.meta.url),'utf8'));
    expect(NotificationChannelSchema.safeParse(row).success).toBe(true);
  });
  it.each([
    {enabled:true,keyState:'not-checked',status:'available',origin:'https://hook.example.test',reasonCodes:[]},
    {enabled:false,keyState:'available',status:'disabled',origin:'https://hook.example.test',reasonCodes:[]},
    {enabled:true,keyState:'unavailable',status:'unavailable',origin:'https://hook.example.test',reasonCodes:[]},
    {enabled:true,keyState:'available',status:'unavailable',origin:'https://hook.example.test',reasonCodes:['channel-key-unavailable']},
    {enabled:true,keyState:'available',status:'unavailable',origin:null,reasonCodes:[]},
    {enabled:true,keyState:'available',status:'unavailable',origin:null,reasonCodes:['unsupported-origin','unsupported-origin']},
  ])('rejects inconsistent independent metadata $keyState/$status/$reasonCodes',patch=>{
    const row=JSON.parse(readFileSync(new URL('../../../server/src/test/resources/scheduling/t7-channel-true-true-true.json',import.meta.url),'utf8'));expect(NotificationChannelSchema.safeParse({...row,...patch}).success).toBe(false);
  });
});
