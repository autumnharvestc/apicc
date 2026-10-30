// Private API/profile fixture setup only. No UI input, production file or TLS override.
import { app, safeStorage } from 'electron';
import { mkdirSync } from 'node:fs';
import { createTokenStore } from '../../../desktop/dist-electron/main/online/tokenStore.js';

function failed(error) { console.error(error); app.exit(1); }
try {
  // Windows GUI-subsystem Electron does not reliably expose redirected stdin.
  const input=JSON.parse(process.env.APICC_F7D_PROFILE_INPUT??'');
  delete process.env.APICC_F7D_PROFILE_INPUT;
  mkdirSync(input.profile,{recursive:true});
  app.setPath('userData',input.profile);
  app.whenReady().then(()=>{
    const store=createTokenStore({dir:input.profile,storage:safeStorage});
    if(!safeStorage.isEncryptionAvailable()) throw Error('Private profile encryption unavailable');
    store.save(input.baseUrl,input.token);
    if(store.load(input.baseUrl)!==input.token)throw Error('Private profile token roundtrip failed');
    console.log(JSON.stringify({profile:input.profile,encrypted:true,roundtrip:true}));
    app.quit();
  }).catch(failed);
} catch(error) { failed(error); }
