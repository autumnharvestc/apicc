import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodeContractProjectFiles, type ContractProject } from '@apicc/core';
import { defaultAgentConfig, runtimeCompatibilityIdForRuntime } from '@apicc/execution/contract';
import { readBuildIdentity } from '@apicc/execution/buildIdentity';
import { serverFixture, freePort, until, command, repo } from '../server-fixture.js';
import { semanticProject, semanticIds, semanticTarget } from '../runtime-semantics.mjs';

export async function f7dFixture(root: string) {
  const resumeRoot=process.env.APICC_F7D_RESUME_ROOT;
  const previous=resumeRoot?JSON.parse(readFileSync(join(resumeRoot,'context.json'),'utf8')):undefined;
  if(resumeRoot){
    const cleanup=JSON.parse(readFileSync(join(resumeRoot,'cleanup.json'),'utf8'));
    if(cleanup.containerRemaining||cleanup.volumeRemaining||cleanup.errors.length)throw Error('Cannot resume an unclean private environment');
  }
  const record=(name:string,value:unknown)=>writeFileSync(join(root,name+'.json'),JSON.stringify(value,null,2)+'\n');
  const events:unknown[]=[];const evidence=(kind:string,value:unknown)=>{events.push({at:new Date().toISOString(),kind,value});record('observations',events);};
  let database:ChildProcess|undefined,server:Awaited<ReturnType<typeof serverFixture>>|undefined;
  let container=false,volume=false;const name='apicc-f7d-'+process.pid,volumeName=name+'-ledger';
  const targetRequests:Array<{path:string;credentialVersion:string;at:string}>=[];
  const sinkRequests:Array<{body:string;eventId:string;at:string}>=[];
  const holds=new Map<string,ServerResponse>();let lostAck=0,webhookStatus=200;
  const ledger=async(executionId:string)=>{
    const probe=readFileSync(new URL('./ledgerProbe.mjs',import.meta.url),'utf8');
    const script=probe+`\nconst intent=await readLedgerIntent('/data/execution-ledger.sqlite',${JSON.stringify(executionId)});console.log(JSON.stringify(intent?{executionId:intent.executionId,jobId:intent.jobId,fact:intent.fact,settled:!!intent.settled}:null));`;
    const child=spawn('docker',['exec',name,'node','--input-type=module','-e',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    if(code!==0)throw Error('Short ledger probe failed: '+stderr);const result=JSON.parse(stdout);evidence('short-ledger-probe',result);return result;
  };
  const target=createServer((request,response)=>{request.resume();request.on('end',()=>{const path=request.url!;const authorization=request.headers.authorization;targetRequests.push({path,credentialVersion:authorization==='Bearer f7d-synthetic-secret-v1'?'1':authorization==='Bearer f7d-synthetic-secret-v2'?'2':'unknown',at:new Date().toISOString()});record('target-requests',targetRequests);response.setHeader('content-type','application/json');if(path.startsWith('/hold'))holds.set(path,response);else response.end('{"token":"fixed-token"}');});});
  const sink=createServer(async(request,response)=>{const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));sinkRequests.push({body:Buffer.concat(chunks).toString(),eventId:String(request.headers['x-apicc-event-id']),at:new Date().toISOString()});record('webhook-requests',sinkRequests);if(lostAck-->0){response.destroy();return;}response.statusCode=webhookStatus;response.end('f7d-synthetic-hmac-key-32-bytes');});
  let bridge:ReturnType<typeof createServer>|undefined;
  const javaHome=process.env.JAVA_HOME!;const java=join(javaHome,'bin/java.exe');
  const close=async()=>{
    const errors:string[]=[];const attempt=async(action:()=>unknown)=>{try{await action();}catch(error){errors.push(String(error));}};
    for(const response of holds.values())response.end('{"token":"fixed-token"}');holds.clear();
    let stopped=false,copied=false;
    if(container){
      await attempt(()=>command('docker',['stop','--time','30',name]));
      await attempt(()=>{const state=JSON.parse(command('docker',['inspect','--format','{{json .State}}',name]));if(state.Running)throw Error('Owned agent still running');stopped=true;evidence('agent-stopped',state);});
      await attempt(()=>{const logs=spawnSync('docker',['logs',name],{encoding:'utf8',windowsHide:true});writeFileSync(join(root,'agent.log'),logs.stdout+'\n'+logs.stderr);if(logs.status!==0)throw Error('Owned agent log collection failed');});
      if(stopped)await attempt(()=>{command('docker',['cp',name+':/data/execution-ledger.sqlite',join(root,'ledger-stopped.sqlite')]);copied=true;});
      if(copied)await attempt(()=>{const db=new DatabaseSync(join(root,'ledger-stopped.sqlite'),{readOnly:true});try{const rows=db.prepare('PRAGMA integrity_check').all();record('ledger-integrity',rows);if(JSON.stringify(rows)!=='[{"integrity_check":"ok"}]')throw Error('Stopped ledger integrity failed');}finally{db.close();}});
      if(stopped&&copied)await attempt(()=>{command('docker',['rm',name]);container=false;});
    }
    if(volume&&!container)await attempt(()=>{command('docker',['volume','rm',volumeName]);volume=false;});
    await attempt(()=>server?.close());
    if(database&&database.exitCode===null){database.kill();await attempt(()=>until(async()=>database!.exitCode!==null||database!.signalCode!==null,Boolean,10000));}
    for(const service of [bridge,target,sink])if(service?.listening)await attempt(async()=>{service.closeAllConnections();await new Promise<void>((resolve,reject)=>service.close(error=>error?reject(error):resolve()));});
    record('cleanup',{at:new Date().toISOString(),containerRemaining:container,volumeRemaining:volume,databasePid:database?.pid,databaseExitCode:database?.exitCode,databaseSignal:database?.signalCode,errors});
    if(errors.length)throw new AggregateError(errors,'Owned acceptance cleanup failed; resources preserved');
  };
  try{
    await new Promise<void>(resolve=>target.listen(previous?Number(new URL(previous.origin).port):0,'0.0.0.0',resolve));await new Promise<void>(resolve=>sink.listen(previous?Number(new URL(previous.sinkOrigin).port):0,'127.0.0.1',resolve));
    const sinkOrigin=`http://127.0.0.1:${(sink.address() as {port:number}).port}`;
    const jar=process.env.APICC_F7D_JAR!;
    const dbRoot=join(root,'database');mkdirSync(dbRoot,{recursive:true});
    if(resumeRoot)copyFileSync(join(resumeRoot,'database/metadata.mv.db'),join(dbRoot,'metadata.mv.db'));
    const listing=command(join(javaHome,'bin/jar.exe'),['tf',jar]);const entry=listing.split(/\r?\n/).find(path=>/^BOOT-INF\/lib\/h2-[^/]+\.jar$/.test(path));if(!entry)throw Error('Candidate H2 dependency missing');
    command(join(javaHome,'bin/jar.exe'),['xf',jar,entry],{cwd:dbRoot});const h2=join(dbRoot,entry);
    command(join(javaHome,'bin/javac.exe'),['-cp',h2,'-d',dbRoot,join(repo,'apps/runner-agent/tests/helpers/F7dDatabase.java')]);
    const ready=join(dbRoot,'ready.txt');const tcpPort=await freePort();
    const readyGate=process.env.APICC_F7D_READY_FAULT==='1'?join(dbRoot,'ready-release'):undefined;
    database=spawn(java,['-cp',h2+';'+dbRoot,'F7dDatabase',join(dbRoot,'metadata'),String(tcpPort),ready],{env:{...process.env,...(readyGate?{APICC_F7D_READY_GATE:readyGate}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});
    for(const stream of [database.stdout,database.stderr])stream?.on('data',bytes=>appendFileSync(join(root,'database.log'),bytes));
    const validReady=(text:string)=>{
      const lines=text.trim().split(/\r?\n/);if(lines.length!==2||!lines[0].startsWith(`jdbc:h2:tcp://127.0.0.1:${tcpPort}/`))return false;
      try{const endpoint=new URL(lines[1]);return endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1'&&Number(endpoint.port)>0&&endpoint.pathname==='/'&&!endpoint.search&&!endpoint.hash&&!endpoint.username&&!endpoint.password;}catch{return false;}
    };
    if(readyGate){
      await until(async()=>existsSync(readyGate+'.entered'),Boolean,10000);const partial=readFileSync(ready,'utf8');
      evidence('partial-ready-rejected',{bytes:Buffer.byteLength(partial),accepted:validReady(partial)});if(validReady(partial))throw Error('Incomplete ready must not be accepted');writeFileSync(readyGate,'released');
    }
    const readyBytes=await until(async()=>existsSync(ready)?readFileSync(ready,'utf8'):'',validReady,10000);const [databaseUrl,databaseHttp]=readyBytes.trim().split(/\r?\n/);
    evidence('database-ready-consumed',{bytes:Buffer.byteLength(readyBytes),databaseUrl,databaseHttp});
    const db=async(sql:string)=>{const response=await fetch(databaseHttp+'/sql',{method:'POST',body:sql,signal:AbortSignal.timeout(10000)});const text=await response.text();if(!response.ok)throw Error(text);return text;};
    const barrier=async(action:string)=>{const response=await fetch(databaseHttp+'/'+action,{method:'POST',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error(await response.text());return response.text();};
    const variables={SPRING_DATASOURCE_URL:databaseUrl,APICC_SCHEDULER_SCANINTERVALMS:'100',APICC_SCHEDULER_CLAIMLEASEMS:'3000',APICC_NOTIFICATION_SCANINTERVALMS:'100',APICC_NOTIFICATION_RETRYMINMS:'1000',APICC_NOTIFICATION_RETRYMAXMS:'1000',APICC_NOTIFICATION_JITTERRATIO:'0',APICC_NOTIFICATION_ALLOWEDWEBHOOKORIGINS:sinkOrigin,APICC_NOTIFICATION_ALLOWHTTPORIGINS:sinkOrigin,APICC_NOTIFICATION_ALLOWEDWEBHOOKCIDRS:'127.0.0.0/8'};
    server=await serverFixture({artifactJar:jar,evidenceParent:root,variables,...(previous?{proxyPort:Number(new URL(previous.baseUrl).port)}:{})});const control=server;
    let token='';const api=async(method:string,path:string,body?:unknown,auth=token):Promise<any>=>{const response=await control.trustedFetch(control.baseUrl+'/api/v1/'+path,{method,headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+auth}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const text=await response.text();if(!response.ok)throw Error(`${method} ${path} (${response.status}) ${text}`);return text?JSON.parse(text):null;};
    const login=await api('POST','auth/login',{username:'t11-owner',password:'t11-password8'},'');token=login.token;
    const ws=(await api('GET','connect')).workspaceId,group=(await api('GET',`workspaces/${ws}/groups`))[0].id;
    const projectId=previous?.projectId??(await api('POST',`workspaces/${ws}/projects`,{groupId:group,name:'F7d 受控调度 / Controlled '+ '长名称'.repeat(12)})).id;
    const projectPath=`workspaces/${ws}/projects/${projectId}`;
    const agentId=previous?.agentId??(await api('POST','agents',{name:'F7d private Linux '+ '长名称'.repeat(10)})).id;
    if(!previous){
    await api('PUT',`agents/${agentId}/workspace-grants`,{workspaceIds:[ws]});await api('PUT',`workspaces/${ws}/agent-project-allocations`,{agentId,projectIds:[projectId]});
    await api('PUT',projectPath+'/execution-settings',{expectedVersion:'0',agentIds:[agentId],defaultAgentId:agentId,policy:{cancelGraceMs:200}});
    await api('PATCH',`agents/${agentId}`,{expectedVersion:'0',config:{maxConcurrentJobs:2,scriptMode:'trusted-core',minFreeDiskBytes:1,heartbeatIntervalMs:100,longPollWaitMs:200,pollTimeoutMarginMs:100,controlRequestTimeoutMs:1000,reconnectMinMs:50,reconnectMaxMs:100,reconnectJitterRatio:0,transferRetryMinMs:50,transferRetryMaxMs:100,transferRetryCycleMs:200}});
    const enrollment=await api('POST',`agents/${agentId}/enrollments`);const enrolled=await api('POST','runner/enroll',{enrollmentToken:enrollment.enrollmentToken},'');
    writeFileSync(join(control.root,'agent-token'),enrolled.agentToken);
    }else copyFileSync(join(previous.fixtureRoot,'agent-token'),join(control.root,'agent-token'));
    writeFileSync(join(control.root,'deployment.json'),JSON.stringify({baseUrl:control.baseUrl+'/api/v1',agentId,tokenFile:'/run/apicc/agent-token',dataDirectory:'/data',trustedCaFile:'/run/apicc/control-ca.pem',bootstrapConfig:{...defaultAgentConfig,minFreeDiskBytes:1}}));
    command('docker',['volume','create',volumeName]);volume=true;
    command('docker',['create','--init','--name',name,'--mount',`type=volume,source=${volumeName},target=/data`,...['deployment.json','agent-token','control-ca.pem'].flatMap(file=>['--mount',`type=bind,source=${join(control.root,file)},target=/run/apicc/${file},readonly`]),process.env.APICC_F7D_IMAGE!]);container=true;
    if(resumeRoot){
      command('docker',['cp',join(resumeRoot,'ledger-stopped.sqlite'),name+':/data/execution-ledger.sqlite']);
      command('docker',['run','--rm','--name',name+'-ledger-init','--user','root','--entrypoint','chown','--mount',`type=volume,source=${volumeName},target=/data`,process.env.APICC_F7D_IMAGE!,'node:node','/data/execution-ledger.sqlite']);
    }
    const previousSession=previous?(await api('GET',`agents/${agentId}`)).runtime?.sessionId:undefined;
    command('docker',['start',name]);
    const registered=await until(()=>api('GET',`agents/${agentId}`),value=>value.runtime&&value.runtime.sessionId!==previousSession&&value.status==='applied'&&value.runtime.configuration.appliedConfigVersion===value.configVersion);
    evidence('new-agent-session',{previous:previousSession??null,current:registered.runtime.sessionId,container:name});
    const identity=await readBuildIdentity();if(registered.runtime.coreBuildId!==identity.coreBuildId||registered.runtime.scriptApiId!==identity.scriptApiId||registered.runtime.runtimeCompatibilityId!==runtimeCompatibilityIdForRuntime('22.19.0','12.4.254.21-node.29',identity.scriptApiId))throw Error('Same-candidate runtime identity mismatch');
    if(!previous)await api('PUT',projectPath+'/credentials/synthetic-credential',{expectedVersion:'0',value:'f7d-synthetic-secret-v1'});
    const origin=`http://${control.authorityHost}:${(target.address() as {port:number}).port}`;
    let assets:any;const publish=async(project:ContractProject)=>{const entries=[...encodeContractProjectFiles(project).files];assets=await api('PUT',projectPath+'/assets',{format:'contract-files-v1',contractProjectId:project.id,expectedVersion:assets?.version??'0',changes:entries.map(([path,content])=>({path,content})),deletes:(assets?.files??[]).map((file:any)=>file.path).filter((path:string)=>!entries.some(([next])=>next===path))});return assets;};
    const initial=semanticProject(origin,false) as ContractProject;if(previous)assets=await api('GET',projectPath+'/assets');else await publish(initial);
    bridge=createServer(async(request,response)=>{
      try{
        if(request.url==='/__f7d/session'){
          // Explicit synthetic browser profile setup; no token URL/query or UI login automation.
          response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'});
          response.end('<!doctype html><meta charset="utf-8"><script>localStorage.setItem("apicc.admin.token",'+JSON.stringify(token)+');location.replace("/");</script>');
          return;
        }
        const chunks:Buffer[]=[];
        for await(const chunk of request)chunks.push(Buffer.from(chunk));
        const body=Buffer.concat(chunks),headers=new Headers();
        for(const [key,value]of Object.entries(request.headers)){
          if(value!==undefined&&!['host','connection','content-length','transfer-encoding'].includes(key))headers.set(key,Array.isArray(value)?value.join(', '):value);
        }
        const upstream=await control.trustedFetch(control.baseUrl+request.url,{method:request.method,headers,...(body.length?{body}:{}),redirect:'error'});
        response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});
        response.end(Buffer.from(await upstream.arrayBuffer()));
      }catch(error){response.writeHead(502);response.end(String(error));}
    });
    await new Promise<void>(resolve=>bridge!.listen(0,'127.0.0.1',resolve));
    const uiUrl=`http://127.0.0.1:${(bridge.address() as {port:number}).port}`;
    const context={root,resumedFrom:resumeRoot??null,fixtureRoot:control.root,baseUrl:control.baseUrl,uiUrl,adminSetupUrl:uiUrl+'/__f7d/session',origin,sinkOrigin,ws,group,projectId,agentId,ownerId:login.user.id,username:'t11-owner',password:'t11-password8',executable:process.env.APICC_F7D_EXE,profile:join(root,'native-profile'),isolatedRoot:join(root,'native-isolation'),nodeExtraCaCerts:join(control.root,'control-ca.pem'),releaseFile:join(root,'ui-release'),identity,javaPid:control.serverPid(),databasePid:database.pid,name,volume:volumeName};record('context',context);
    const prepareUiProfile=async()=>{
      mkdirSync(context.profile,{recursive:true});mkdirSync(context.isolatedRoot,{recursive:true});
      const environment={...process.env,APICC_F7D_PROFILE_INPUT:JSON.stringify({profile:context.profile,baseUrl:control.baseUrl,token})};delete (environment as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
      const child=spawn(join(repo,'apps/desktop/node_modules/electron/dist/electron.exe'),[join(repo,'apps/runner-agent/tests/helpers/f7dProfile.mjs')],{env:environment,windowsHide:true,stdio:['pipe','pipe','pipe']});
      child.stdin.end();
      let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
      const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
      writeFileSync(join(root,'profile-setup.stdout.log'),stdout);writeFileSync(join(root,'profile-setup.stderr.log'),stderr);
      if(code!==0)throw Error('Private encrypted profile setup failed');evidence('profile-setup',{pid:child.pid,exitCode:code,profile:context.profile});
    };
    const restart=async()=>{const before=control.serverPid();await control.stop();await control.start(variables);const after=control.serverPid();if(before===after)throw Error('Java PID did not change');evidence('java-restart',{before,after,databasePid:database?.pid});};
    return {root,api,db,barrier,server:control,close,evidence,record,context,publish,assets:()=>assets,initial,projectPath,agentId,ws,projectId,origin,sinkOrigin,identity,targetRequests,sinkRequests,holds,restart,ledger,prepareUiProfile,setWebhookStatus:(status:number)=>{webhookStatus=status;},dropWebhookAck:()=>lostAck++,semanticIds,semanticTarget,agentName:name};
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'F7d fixture and cleanup failed');}throw error;}
}
