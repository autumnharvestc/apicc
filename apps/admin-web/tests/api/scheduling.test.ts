// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {actualChannels,jsonResponse,schedulingHarness} from '../helpers/scheduling.js';
import {createSchedulingApi} from '../../src/api/scheduling.js';
describe('scheduling administration scope',()=>{
  it.each(['create-workspace','update-workspace','update-channel'])('rejects the response scope mismatch %s',async kind=>{
    const row={...actualChannels().created['host-case'],...(kind==='update-channel'?{id:'99'}:{workspaceId:'2'})};const h=schedulingHarness(()=>jsonResponse(row));const api=createSchedulingApi(h.client);
    const result=kind==='create-workspace'?api.createChannel('1',{expectedVersion:'0',name:'渠道',url:'https://hook.example.test/private',hmacSecret:'synthetic-hmac-value',enabled:false}):api.updateChannel('1',actualChannels().created['host-case'].id,{expectedVersion:'1',name:'渠道'});
    await expect(result).rejects.toThrow('notification-scope-mismatch');
  });
});
