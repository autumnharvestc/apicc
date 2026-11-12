import { describe, expect, it, vi } from 'vitest';
import { createProjectSnapshot, exportOpenapi } from '@apicc/core';
import { lossyExportDialog } from '../../src/main/designExportDialog.js';
import { createIpcDeps } from '../../src/main/ipc.js';
import { createSession } from '../../src/main/session.js';
import { IpcChannel } from '../../src/shared/channels.js';
import { DesignExportInputSchema } from '../../src/shared/design.js';
import { IDS, makeTempRoot, makeWorkspace, persistWorkspace, projectOne } from './helpers/contract-assets.js';

describe('native design export locale', () => {
  it.each(['zh-CN','en'] as const)('keeps diagnostics and safe cancel defaults in %s', locale => {
    const facts=Array.from({length:12},(_,i)=>({code:`CODE_${i}`,path:'contract.body',message:'original business text'}));
    const box=lossyExportDialog(facts,locale);
    expect(box.buttons).toEqual(locale==='en'?['Cancel','Export anyway']:['取消','仍然导出']);
    expect(box.title).toBe(locale==='en'?'OpenAPI export may lose semantics':'OpenAPI 导出可能丢失语义');
    expect(box.detail).toContain('CODE_0 — contract.body: original business text');
    expect(box.detail).not.toContain('CODE_10');
    expect(box.detail).toContain(locale==='en'?'2 more diagnostic(s)':'另有 2 项诊断');
    expect(box).toMatchObject({type:'warning',defaultId:0,cancelId:0,noLink:true});
  });
  it.each(['zh-CN','en'] as const)('passes %s through strict IPC and cancellation never writes', async locale => {
    const temp=await makeTempRoot('apicc-p5-export-');
    try {
      const workspace=makeWorkspace(),project=projectOne(workspace),asset=project.collections[0]!.apis[0]!;
      if(asset.contract.request.protocol!=='http')throw new Error('HTTP required');
      asset.contract.request.body={kind:'graphql',query:'query Example { id }'};
      asset.contract.responses=[{kind:'inline',id:IDS.response,status:'200',description:'OK',headers:{},content:{}}];
      const candidate=exportOpenapi(createProjectSnapshot(project),{kind:'apis',contractIds:[IDS.sharedApi]},{version:'3.1',allowLossy:false});
      expect(candidate.diagnostics.filter(d=>d.severity==='error')).toEqual([]);
      await persistWorkspace(temp.path,workspace);
      const session=createSession();await session.open(temp.path);
      const confirm=vi.fn(async (_diagnostics: readonly {code:string;path:string;message:string}[], _locale:'zh-CN'|'en')=>false),save=vi.fn(async()=>'/unused');
      const deps=createIpcDeps({session,pickDirectory:async()=>temp.path,saveFile:save,confirmLossyExport:confirm});
      const input={sourceRoot:temp.path,locator:{workspaceId:IDS.workspace,groupId:IDS.groupOne,projectId:IDS.projectOne,collectionId:IDS.collectionOne,folderIds:[],apiId:IDS.sharedApi},format:'openapi-3.1',scope:{kind:'apis',contractIds:[IDS.sharedApi]},locale};
      const result=await Reflect.apply(deps.handle,undefined,[IpcChannel.DesignExport,null,input]);
      expect(result).toBe('');expect(save).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({code:'OPENAPI_GRAPHQL_SEMANTICS_UNSUPPORTED'})]),locale);
      expect(DesignExportInputSchema.safeParse({...input,locale:'unknown'}).success).toBe(false);
      const {locale:ignored,...legacy}=input;
      expect(DesignExportInputSchema.safeParse(legacy).success).toBe(true);
      await Reflect.apply(deps.handle,undefined,[IpcChannel.DesignExport,null,legacy]);
      expect(confirm.mock.calls.at(-1)?.[1]).toBe('en');
    } finally {await temp.dispose();}
  });
});
