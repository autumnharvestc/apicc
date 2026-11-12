import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const req=createRequire(path.join(root,'apps/admin-web/package.json'));
const {createServer}=await import(pathToFileURL(req.resolve('vite')).href);
const {default:vue}=await import(pathToFileURL(req.resolve('@vitejs/plugin-vue')).href);
const server=await createServer({configFile:false,root:fileURLToPath(new URL('./',import.meta.url)),plugins:[vue()],resolve:{alias:[{find:'@admin',replacement:path.join(root,'apps/admin-web/src')},{find:/^@apicc\/execution\/contract$/,replacement:req.resolve('@apicc/execution/contract')},{find:/^vue$/,replacement:req.resolve('vue/dist/vue.esm-bundler.js')},{find:/^ant-design-vue$/,replacement:req.resolve('ant-design-vue/es/index.js')},{find:/^ant-design-vue\/(.*)$/,replacement:path.join(path.dirname(req.resolve('ant-design-vue/package.json')),'$1')},{find:/^vue-router$/,replacement:req.resolve('vue-router/dist/vue-router.mjs')}]},server:{host:'127.0.0.1',port:63578,strictPort:true,fs:{allow:[root]}}});
await server.listen();server.printUrls();
