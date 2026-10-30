import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';

// The outer Invoke-F7dCommand wrapper records argv/source/exit. This index also
// records subprocesses and exact candidate artifacts, without touching Git index.
const repo=resolve(import.meta.dirname,'..');
const phase=process.argv[2];
const provided=process.argv[3];
const parent=join(repo,'local/f7d-acceptance');mkdirSync(parent,{recursive:true});
const root=phase==='desktop-refresh'?mkdtempSync(join(parent,'candidate-')):provided?resolve(provided):mkdtempSync(join(parent,'candidate-'));
if(relative(parent,root).startsWith('..')||relative(parent,root)==='')throw Error('Expected unique evidence child');
mkdirSync(root,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const indexFile=join(root,'index.json');
const index=existsSync(indexFile)?JSON.parse(readFileSync(indexFile,'utf8')):{root,createdAt:new Date().toISOString(),commands:[],artifacts:[]};
function persist(){writeFileSync(indexFile,JSON.stringify(index,null,2)+'\n');}
async function run(label,file,args,cwd=repo,extra={}){
  const record={label,file,args,cwd,startedAt:new Date().toISOString(),...extra};index.commands.push(record);persist();
  const batch=process.platform==='win32'&&/\.(cmd|bat)$/i.test(file);
  const quote=s=>/[\s&|<>^()]/.test(s)?`"${s}"`:s;
  const child=spawn(batch?'cmd.exe':file,batch?['/d','/s','/c',`"${[file,...args].map(quote).join(' ')}"`]:args,{cwd,env:process.env,windowsHide:true,windowsVerbatimArguments:batch,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  writeFileSync(join(root,label+'.stdout.log'),stdout);writeFileSync(join(root,label+'.stderr.log'),stderr);
  Object.assign(record,{pid:child.pid,finishedAt:new Date().toISOString(),exitCode:code});persist();
  if(code!==0)throw Error(`${label} failed (${code}); see ${root}`);return stdout.trim();
}
function files(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(directory,entry.name)):[join(directory,entry.name)]);}
function artifact(path){for(const file of statSync(path).isDirectory()?files(path):[path])index.artifacts.push({path:relative(repo,file).replaceAll('\\','/'),bytes:statSync(file).size,sha256:sha(readFileSync(file))});persist();}
try{
  if(phase==='build'){
    index.head=await run('head','git',['rev-parse','HEAD']);
    const tracked=(await run('tracked-files','git',['ls-files'])).split(/\r?\n/);
    const untracked=(await run('untracked-files','git',['ls-files','--others','--exclude-standard'])).split(/\r?\n/).filter(Boolean);
    index.source=[...new Set([...tracked,...untracked])].filter(path=>existsSync(join(repo,path))).map(path=>({path,sha256:sha(readFileSync(join(repo,path)))}));
    index.sourceManifestSha256=sha(JSON.stringify(index.source));persist();
    const pnpm=join(repo,'local/f7b-t11/pnpm-shim/pnpm.cmd');
    for(const packagePath of ['packages/plugin-sdk','packages/core','packages/execution','apps/admin-web','apps/runner-agent'])await run(packagePath.replaceAll('/','-'),pnpm,['--config.verify-deps-before-run=false','-C',packagePath,'build']);
    await run('java-package','D:/ide/JetBrains/IntelliJ IDEA 2026.2.3/plugins/maven-plugin/lib/maven3/bin/mvn.cmd',['-s',join(repo,'server/.mvn/settings.xml'),'-f',join(repo,'server/pom.xml'),`-Dapicc.build.directory=${join(root,'maven')}`,'-DskipTests','package']);
    index.jar=join(root,'maven',readdirSync(join(root,'maven')).find(name=>/^apicc-server-.+\.jar$/.test(name)));artifact(index.jar);
    await run('windows-directory',pnpm,['--config.verify-deps-before-run=false','-C','apps/desktop','dist:dir','--config.directories.output='+join(root,'windows')]);
    index.executable=join(root,'windows/win-unpacked/apicc.exe');artifact(join(root,'windows/win-unpacked'));
    index.agentImage='apicc-f7d-agent:'+relative(parent,root).toLowerCase();index.serverImage='apicc-f7d-server:'+relative(parent,root).toLowerCase();persist();
    await run('docker-agent','docker',['build','-f','Dockerfile.agent','-t',index.agentImage,'.']);
    await run('docker-server','docker',['build','-f','Dockerfile','-t',index.serverImage,'.']);
    index.images=JSON.parse(await run('docker-identities','docker',['image','inspect',index.agentImage,index.serverImage]));
    await run('windows-smoke',process.execPath,['apps/desktop/scripts/smoke-dir.mjs','--exe',index.executable]);
    index.phase='built';persist();console.log(`F7D_CANDIDATE ${indexFile}`);
  }else if(phase==='desktop-refresh'){
    if(!provided)throw Error('Original candidate required');
    const original=JSON.parse(readFileSync(join(resolve(provided),'index.json'),'utf8'));
    if(original.phase!=='built')throw Error('Original candidate must be built');
    const tracked=(await run('tracked-files','git',['ls-files'])).split(/\r?\n/);
    const untracked=(await run('untracked-files','git',['ls-files','--others','--exclude-standard'])).split(/\r?\n/).filter(Boolean);
    index.head=await run('head','git',['rev-parse','HEAD']);
    index.source=[...new Set([...tracked,...untracked])].filter(path=>existsSync(join(repo,path))).map(path=>({path,sha256:sha(readFileSync(join(repo,path)))}));
    index.sourceManifestSha256=sha(JSON.stringify(index.source));
    const allowed=path=>path.startsWith('apps/desktop/')||path.startsWith('docs/')||path.includes('/tests/')||path.endsWith('.md')||path==='scripts/f7d-acceptance.mjs';
    const drift=original.source.filter(entry=>!allowed(entry.path)&&sha(readFileSync(join(repo,entry.path)))!==entry.sha256);
    if(drift.length)throw Error('Non-desktop runtime source changed: '+drift.map(entry=>entry.path).join(','));
    Object.assign(index,{reusedFrom:original.root,jar:original.jar,agentImage:original.agentImage,serverImage:original.serverImage,images:original.images,unchangedRuntimeSource:true});
    artifact(index.jar);persist();
    await run('reused-docker-identities','docker',['image','inspect',index.agentImage,index.serverImage]);
    await run('windows-directory',join(repo,'local/f7b-t11/pnpm-shim/pnpm.cmd'),['--config.verify-deps-before-run=false','-C','apps/desktop','dist:dir','--config.directories.output='+join(root,'windows')]);
    index.executable=join(root,'windows/win-unpacked/apicc.exe');artifact(join(root,'windows/win-unpacked'));
    await run('windows-smoke',process.execPath,['apps/desktop/scripts/smoke-dir.mjs','--exe',index.executable]);
    index.phase='built';persist();console.log(`F7D_CANDIDATE ${indexFile}`);
  }else if(phase==='profile-smoke'){
    const profile=mkdtempSync(join(root,'profile-smoke-'));
    process.env.APICC_F7D_PROFILE_INPUT=JSON.stringify({profile,baseUrl:'https://127.0.0.1:1',token:'f7d-diagnostic-only-not-a-valid-token'});
    try{await run('profile-smoke-'+relative(root,profile),join(repo,'apps/desktop/node_modules/electron/dist/electron.exe'),[join(repo,'apps/runner-agent/tests/helpers/f7dProfile.mjs')]);}
    finally{delete process.env.APICC_F7D_PROFILE_INPUT;}
  }else if(phase==='server-smoke'){
    const name='apicc-f7d-server-smoke-'+process.pid,volume=name+'-data';
    let created=false,volumeCreated=false,stopped=false;
    let failure,containerRemaining=null,volumeRemaining=null,running=null;
    const errors=[];
    const attempt=async(stage,action)=>{try{return await action();}catch(error){errors.push({stage,error:String(error)});}};
    try{
      await run('server-smoke-volume','docker',['volume','create',volume]);volumeCreated=true;
      await run('server-smoke-start','docker',['run','--detach','--init','--name',name,'-p','127.0.0.1::8080','--mount',`type=volume,source=${volume},target=/data`,'-e','APICC_SERVER_ADMIN_USERNAME=f7d-smoke','-e','APICC_SERVER_ADMIN_PASSWORD=f7d-synthetic-password8',index.serverImage]);created=true;
      const port=JSON.parse(await run('server-smoke-port','docker',['inspect','--format','{{json .NetworkSettings.Ports}}',name]))['8080/tcp'][0].HostPort;
      const deadline=Date.now()+60000;let ping;
      while(Date.now()<deadline){try{const response=await fetch(`http://127.0.0.1:${port}/api/v1/ping`,{signal:AbortSignal.timeout(1000)});if(response.ok){ping=await response.json();break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
      if(ping?.status!=='ok')throw Error('Candidate server image readiness failed');
      const consoleResponse=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(3000)});const html=await consoleResponse.text();if(!consoleResponse.ok||!html.includes('<div id="app">'))throw Error('Candidate image console missing');
      await run('server-smoke-copy-jar','docker',['cp',name+':/app/app.jar',join(root,'image-server.jar')]);artifact(join(root,'image-server.jar'));
      index.serverSmoke={name,volume,port,ping,consoleStatus:consoleResponse.status,image:index.serverImage};persist();
    }catch(error){failure=error;}finally{
      try{
        if(created){
          await attempt('server-smoke-stop',()=>run('server-smoke-stop','docker',['stop','--time','30',name]));
          await attempt('server-smoke-state',async()=>{
            const state=JSON.parse(await run('server-smoke-state','docker',['inspect','--format','{{json .State}}',name]));
            if(state.Running!==false)throw Error('Candidate server image did not confirm stopped');stopped=true;
          });
          if(stopped){
            await attempt('server-smoke-logs',()=>run('server-smoke-logs','docker',['logs',name]));
            await attempt('server-smoke-remove',()=>run('server-smoke-remove','docker',['rm',name]));
          }
        }
        if(volumeCreated&&(!created||stopped))await attempt('server-smoke-volume-remove',()=>run('server-smoke-volume-remove','docker',['volume','rm',volume]));
      }finally{
        await attempt('server-smoke-container-remaining',async()=>{containerRemaining=(await run('server-smoke-container-remaining','docker',['ps','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}'])).split(/\r?\n/).includes(name);});
        await attempt('server-smoke-volume-remaining',async()=>{volumeRemaining=(await run('server-smoke-volume-remaining','docker',['volume','ls','--filter','name='+volume,'--format','{{.Name}}'])).split(/\r?\n/).includes(volume);});
        if(containerRemaining===false)running=false;
        else if(containerRemaining===true)await attempt('server-smoke-final-state',async()=>{
          const state=JSON.parse(await run('server-smoke-final-state','docker',['inspect','--format','{{json .State}}',name]));
          if(typeof state.Running!=='boolean')throw Error('Candidate server running state unavailable');running=state.Running;
        });
        index.serverSmokeCleanup={name,volume,stopped,containerRemaining,volumeRemaining,running,errors,bodyError:failure?String(failure):null,finishedAt:new Date().toISOString()};persist();
      }
    }
    if(failure||errors.length)throw new AggregateError([...(failure?[failure]:[]),...errors.map(error=>Error(error.stage+': '+error.error))],'Candidate server smoke or cleanup failed');
  }else if(phase==='run'){
    if(index.phase!=='built')throw Error('Candidate build required');
    const runtimeRoot=mkdtempSync(join(root,'run-'));index.runs??=[];index.runs.push(runtimeRoot);persist();
    Object.assign(process.env,{APICC_F7D_ROOT:runtimeRoot,APICC_F7D_JAR:index.jar,APICC_F7D_IMAGE:index.agentImage,APICC_F7D_EXE:index.executable});
    await run('controlled-acceptance-'+relative(root,runtimeRoot),join(repo,'local/f7b-t11/pnpm-shim/pnpm.cmd'),['--config.verify-deps-before-run=false','-C','apps/runner-agent','exec','vitest','run','tests/f7d-acceptance.test.ts','--maxWorkers=2','--bail=1',...(process.env.APICC_F7D_FILTER?['--testNamePattern',process.env.APICC_F7D_FILTER]:[])]);
    index.lastRuntimeSuccess=runtimeRoot;persist();
  }else throw Error('Usage: node scripts/f7d-acceptance.mjs build | run <candidate-root>');
}catch(error){index.failure=String(error);persist();console.error(error);process.exitCode=1;}
