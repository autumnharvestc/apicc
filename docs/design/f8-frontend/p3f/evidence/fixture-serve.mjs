import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const desktopRequire=createRequire(path.join(root,'apps/desktop/package.json'));
const adminRequire=createRequire(path.join(root,'apps/admin-web/package.json'));
const {createServer}=await import(pathToFileURL(desktopRequire.resolve('vite')).href);
const {default:vue}=await import(pathToFileURL(desktopRequire.resolve('@vitejs/plugin-vue')).href);
const server=await createServer({configFile:false,root:fileURLToPath(new URL('./',import.meta.url)),plugins:[vue()],resolve:{alias:[{find:'@desktop',replacement:path.join(root,'apps/desktop/src/renderer/src')},{find:'@admin',replacement:path.join(root,'apps/admin-web/src')},{find:/^vue$/,replacement:desktopRequire.resolve('vue/dist/vue.esm-bundler.js')},{find:/^ant-design-vue$/,replacement:desktopRequire.resolve('ant-design-vue/es/index.js')},{find:/^ant-design-vue\/(.*)$/,replacement:path.join(path.dirname(desktopRequire.resolve('ant-design-vue/package.json')),'$1')},{find:/^vue-router$/,replacement:adminRequire.resolve('vue-router/dist/vue-router.mjs')}]},server:{host:'127.0.0.1',port:63575,strictPort:true,fs:{allow:[root]}}});
const {writeFile,readFile}=await import('node:fs/promises');
const scheduling=await server.ssrLoadModule(path.join(root,'apps/desktop/tests/helpers/scheduling.ts'));
const cf=await server.ssrLoadModule(path.join(root,'apps/desktop/tests/renderer/components/collaboration-fixtures.ts'));
const contracts=await server.ssrLoadModule(path.join(root,'packages/core/tests/helpers/contractFixtures.ts'));
const project=contracts.workspaceFixture().groups[0].projects[0];
project.workflows=[{id:scheduling.workflowId,name:'回归流程 / Regression workflow',status:'enabled',nodes:[{id:'noop',kind:'noop'}],edges:[]}];
project.stressPlans=[{id:'00000000-0000-4000-8000-000000000099',name:'接口容量基线 / Capacity baseline',plan:{formatVersion:1,target:{kind:'workflow',workflowId:scheduling.workflowId},load:{kind:'constant-vus',vus:2},termination:{maxIterations:10}}}];
const {ContractProjectSchema,StressPlanSchema}=await import(pathToFileURL(path.join(root,'packages/core/dist/schema.js')).href);
project.stressPlans=project.stressPlans.map(row=>({...row,formatVersion:1,updatedAt:0,plan:StressPlanSchema.parse({...row.plan,maxVus:2})}));
Object.assign(project,ContractProjectSchema.parse(project));
const np=JSON.parse(await readFile(path.join(root,'server/src/test/resources/notifications/center.json'),'utf8'));
const nh=JSON.parse(await readFile(path.join(root,'server/src/test/resources/notifications/history.json'),'utf8'));
np.items=np.items.map(row=>({...row,workspaceId:'11',projectId:'33',projectName:'合成支付服务 / Synthetic payment service',scheduleName:'每日回归 · Payment regression with a long readable name',link:'/workspaces/11/projects/33/schedules/6',notificationState:'failed',deliveries:nh.items[0].deliveries}));
const nh2={...nh,workspaceId:'11',projectId:'33',scheduleId:scheduling.scheduleView().id};
const history=JSON.parse(await readFile(path.join(root,'server/src/test/resources/scheduling/history.json'),'utf8'));
Object.assign(history,{workspaceId:'11',projectId:'33',scheduleId:scheduling.scheduleView().id,items:history.items.map(row=>({...row,workspaceId:'11',projectId:'33',scheduleId:scheduling.scheduleView().id,materials:{...row.materials,projectId:'33'}}))});
const cp=cf.port();
await writeFile(new URL('./seed.json',import.meta.url),JSON.stringify({context:scheduling.scheduleContext,project,agents:scheduling.scheduleAgents(),schedule:scheduling.scheduleView(),options:scheduling.scheduleOptions(),preparation:scheduling.schedulePreparation(),notifications:np,notificationHistory:nh2,history,local:cf.local(),source:cf.source,access:await cp.onlineCollaboration({operation:'access',context:cf.context,input:{}}),publications:await cp.onlineCollaboration({operation:'publications',context:cf.context,input:{}}),grants:await cp.onlineCollaboration({operation:'grants',context:cf.context,input:{publicationId:'41'}}),sharedHistory:[cf.history(),cf.history('member-history')]}));

await server.listen();
server.printUrls();



