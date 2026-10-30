import { z } from 'zod';
import { EntityIdSchema,ConfigVersionSchema, SchedulePolicyViewSchema,SchedulePolicyUpdateSchema,NotificationChannelPageSchema,NotificationChannelSchema,NotificationChannelCreateSchema,NotificationChannelUpdateSchema,SchedulerControlSchema,SchedulerControlUpdateSchema,ScheduleGrantOptionsSchema,ScheduleGrantsSchema,ScheduleGrantUpdateSchema,type NotificationChannel } from '@apicc/execution/contract';
import type { AdminClient } from './client.js';
export type { SchedulePolicyView } from '@apicc/execution/contract';
export type { NotificationChannel } from '@apicc/execution/contract';
export type { ScheduleGrantOptions } from '@apicc/execution/contract';
export function createSchedulingApi(client:AdminClient){
  const scope=(ws:string,project?:string)=>`/workspaces/${EntityIdSchema.parse(ws)}${project?`/projects/${EntityIdSchema.parse(project)}`:''}`;
  const call=async<T>(method:string,path:string,schema:z.ZodType<T>,body?:unknown)=>await client.request({method,path,schema,body}) as T;
  const channelScope=(ws:string,row:NotificationChannel,id?:string)=>{if(row.workspaceId!==ws||id!==undefined&&row.id!==id)throw new Error('notification-scope-mismatch');return row;};
  return {
    grantOptions:(ws:string,project:string)=>call('GET',`${scope(ws,project)}/schedule-grants/options`,ScheduleGrantOptionsSchema),
    grants:(ws:string,project:string)=>call('GET',`${scope(ws,project)}/schedule-grants`,ScheduleGrantsSchema),
    saveGrants:(ws:string,project:string,input:z.input<typeof ScheduleGrantUpdateSchema>)=>call('PUT',`${scope(ws,project)}/schedule-grants`,ScheduleGrantsSchema,ScheduleGrantUpdateSchema.parse(input)),
    control:()=>call('GET','/scheduler/control',SchedulerControlSchema),
    saveControl:(input:z.input<typeof SchedulerControlUpdateSchema>)=>call('PUT','/scheduler/control',SchedulerControlSchema,SchedulerControlUpdateSchema.parse(input)),
    policy:(ws:string,project?:string)=>call('GET',`${scope(ws,project)}/schedule-policy`,SchedulePolicyViewSchema),
    savePolicy:(ws:string,project:string|undefined,input:z.input<typeof SchedulePolicyUpdateSchema>)=>call('PUT',`${scope(ws,project)}/schedule-policy`,SchedulePolicyViewSchema,SchedulePolicyUpdateSchema.parse(input)),
    channels:async(ws:string)=>{const page=await call('GET',`${scope(ws)}/notification-channels`,NotificationChannelPageSchema);page.items.forEach(row=>channelScope(ws,row));return page;},
    createChannel:async(ws:string,input:z.input<typeof NotificationChannelCreateSchema>)=>channelScope(ws,await call('POST',`${scope(ws)}/notification-channels`,NotificationChannelSchema,NotificationChannelCreateSchema.parse(input))),
    updateChannel:async(ws:string,id:string,input:z.input<typeof NotificationChannelUpdateSchema>)=>channelScope(ws,await call('PUT',`${scope(ws)}/notification-channels/${EntityIdSchema.parse(id)}`,NotificationChannelSchema,NotificationChannelUpdateSchema.parse(input)),id),
    deleteChannel:(ws:string,id:string,version:string)=>client.request({method:'DELETE',path:`${scope(ws)}/notification-channels/${EntityIdSchema.parse(id)}`,query:{expectedVersion:ConfigVersionSchema.parse(version)}}),
  };
}
