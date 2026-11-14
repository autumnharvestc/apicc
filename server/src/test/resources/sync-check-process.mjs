import { createServer, request } from 'node:http';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFromDeployment } from '../../../../apps/collaboration-runtime/dist/limits.js';
import { createProjectSnapshot } from '../../../../packages/core/dist/collaboration/index.js';
import { encodeContractProjectFiles } from '../../../../packages/core/dist/storage/contractFiles.js';
import { ContractProjectSchema } from '../../../../packages/core/dist/contract/workspace.js';
const directory=process.argv[2], privateRoot=join(directory,'private');
await mkdir(privateRoot,{recursive:true});
const project=ContractProjectSchema.parse({id:'00000000-0000-4000-8000-000000000070',name:'T9',globals:{},collections:[{id:'00000000-0000-4000-8000-000000000071',name:'Target',apis:[],folders:[]},{id:'00000000-0000-4000-8000-000000000072',name:'Second',apis:[],folders:[]}],models:[],components:[]});
const projectFiles = value => [...encodeContractProjectFiles(value).files].map(([path, content]) => ({ path, content }));
const initialFiles = projectFiles({ ...project, name: 'T7' });
const files = projectFiles(project);
const rawText=JSON.stringify({openapi:'3.0.3',info:{title:'Target',version:'1.0.0'},paths:{'/pets':{get:{operationId:'listPets',responses:{200:{description:'OK'}}}}}});
const changedText=JSON.stringify({openapi:'3.0.3',info:{title:'Target',version:'1.0.0'},paths:{'/pets':{get:{operationId:'listPets',summary:'Changed upstream operation',responses:{200:{description:'OK'}}}}}});
let calls=0,cache304=0,dropNextRead=false,lostResponse,holdResolve=false,releaseResolve,failClassify=false;const blocked=new Map(),revisions=new Map();
const source=createServer((req,res)=>{
  if(req.url.startsWith('/set-revision/')){const [, ,id,revision]=req.url.split('/');revisions.set(id,revision);res.end('set');return;}
  if(req.url==='/fail-classify'){failClassify=true;res.end('armed');return;}
  if(req.url==='/hold-resolve'){holdResolve=true;res.end('armed');return;}
  if(req.url==='/release-resolve'){releaseResolve?.();releaseResolve=undefined;res.end('released');return;}
  if(req.url==='/control') {res.end(JSON.stringify({calls,cache304,...runtime.sourceCapacity()}));return;}
  if(req.url==='/drop-next') {dropNextRead=true;res.end('armed');return;}
  if(req.url.startsWith('/release/')) {const id=req.url.slice(9);blocked.get(id)?.end(rawText);blocked.delete(id);res.end('released');return;}
  calls++;void writeFile(join(directory,'calls'),String(calls));
  if(lostResponse){lostResponse.destroy();lostResponse=undefined;void writeFile(join(directory,'transport-lost'),'closed');}
  if(req.url.startsWith('/auth')&&req.headers.authorization!=='Bearer synthetic-t9'){res.writeHead(401);res.end('credential required');return;}
  if(req.url.startsWith('/blocked/')||req.url.startsWith('/auth/blocked/')) {const id=req.url.split('/').at(-1);res.writeHead(200,{'content-type':'application/json'});blocked.set(id,res);void writeFile(join(directory,'received-'+id),'received');req.socket.once('close',()=>{void writeFile(join(directory,'collected-'+id),'closed');blocked.delete(id);});return;}
  if(req.url.startsWith('/cache')&&req.headers['if-none-match']==='"v1"'){cache304++;res.writeHead(304);res.end();return;}
  res.writeHead(200,{'content-type':'application/json',etag:'"v1"'});res.end(req.url.startsWith('/changing/')&&revisions.get(req.url.slice('/changing/'.length))==='B'?changedText:rawText);
});
await new Promise(done=>source.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${source.address().port}`,secretFile=join(directory,'rpc-key'),sourceConfigFile=join(directory,'source.json');
await writeFile(secretFile,'synthetic-secret-0123456789abcdef');
await writeFile(sourceConfigFile,JSON.stringify({privateRoot,allowedOrigins:[origin],allowedCidrs:['127.0.0.1/32'],maxRedirects:0}));
const runtime=await runtimeFromDeployment({enabled:true,secretFile,sourceConfigFile,port:0});
if(!runtime.enabled)throw Error('Actual runtime prerequisite');
// A real transport-loss proxy deliberately leaves its already-forwarded private read alive.
const proxy=createServer((req,res)=>{void forward(req,res).catch(failFixture);});
async function forward(req,res){
  const chunks=[];
  try {for await(const chunk of req)chunks.push(chunk);}
  catch(error){
    // Java cancellation can arrive while the proxy is still reading a body.
    // Only that request ends; it must not terminate every fixture consumer.
    if(req.aborted||error.code==='ECONNRESET'||error.code==='ERR_STREAM_PREMATURE_CLOSE'){res.destroy();return;}
    throw error;
  }
  const body=Buffer.concat(chunks);let parsed;
  try {parsed=JSON.parse(body.toString());}
  catch(error){if(!(error instanceof SyntaxError))throw error;res.writeHead(400);res.end('Invalid JSON');return;}
  const operation=parsed?.operation,requestId=parsed?.requestId;
  const preserve=dropNextRead&&operation==='sync-read';if(preserve){dropNextRead=false;lostResponse=res;}
  await appendFile(join(directory,'rpc-trace.jsonl'),JSON.stringify({phase:'received',operation,requestId,bytes:body.length})+'\n');if(failClassify&&operation==='classify-asset-mutation'){failClassify=false;res.writeHead(503);res.end('synthetic classifier unavailable');return;}
  const pause=holdResolve&&(operation==='sync-resolve'||operation==='sync-rollback');if(pause){holdResolve=false;await writeFile(join(directory,'resolve-held'),'held');await new Promise(done=>{releaseResolve=done;});}
  if(res.destroyed&&!preserve)return;
  const transportError=error=>{void appendFile(join(directory,'rpc-trace.jsonl'),JSON.stringify({phase:'error',operation,requestId,code:error.code})+'\n').catch(failFixture);if(!res.destroyed)res.destroy();};
  const upstream=request(new URL(req.url,runtime.url),{method:req.method,headers:req.headers},reply=>{
    reply.on('error',transportError);
    void appendFile(join(directory,'rpc-trace.jsonl'),JSON.stringify({phase:'reply',operation,requestId,status:reply.statusCode})+'\n').catch(failFixture);
    if(res.destroyed)reply.resume();else{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);}
  });
  res.once('close',()=>{if(!preserve&&!res.writableEnded)upstream.destroy();});upstream.on('error',transportError);upstream.end(body);
}
let fatalError;
function failFixture(error){
  if(fatalError)return;fatalError=error;console.error('Shared sync fixture failed:',error);process.exitCode=1;
  void stop().catch(shutdownError=>{console.error('Shared sync fixture shutdown failed:',shutdownError);process.exit(1);});
}
await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
console.log(JSON.stringify({url:`http://127.0.0.1:${proxy.address().port}`,origin,secretFile,rawText,initialFiles,files,definitionRevision:createProjectSnapshot(project).definitionRevision}));
let stopping;const stop=()=>stopping??=(async()=>{await runtime.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));source.closeAllConnections();await new Promise(done=>source.close(done));process.stdin.destroy();})();
process.stdin.once('data',()=>void stop());process.stdin.once('end',()=>void stop());
