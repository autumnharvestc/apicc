import {it,expect} from 'vitest';
import {collectNetworkDependencies} from '../../src/network/prepare.js';
const ref=(id:string)=>({id,policy:'test-auto'});
const configuration={formatVersion:1,projectSelection:{kind:'direct'},environmentSelections:[{environmentId:'production',selection:{kind:'profile',profileId:'proxy'}}],profiles:[{id:'proxy',name:'Controlled proxy',kind:'proxy',proxyUrl:'https://proxy.test',username:'user',passwordRef:ref('proxy-pass'),proxyTLS:{caCertificatePaths:['C:/explicit/proxy.pem']},targetTlsBindings:[{origin:'https://target.test',tls:{clientCertificatePaths:['C:/explicit/client.pem'],clientPrivateKeyRef:ref('client-key'),clientKeyPassphraseRef:ref('key-pass')}}]}]};
it('collects exactly the selected environment credentials and public files without reading any path',()=>{
  const result=collectNetworkDependencies({configuration,environmentId:'production'});
  expect(result.selection).toEqual({kind:'profile',profileId:'proxy'});
  expect(result.secretNeeds.map(n=>n.ref.id)).toEqual(['proxy-pass','client-key','key-pass']);
  expect(result.certificatePaths.map(n=>n.path)).toEqual(['C:/explicit/client.pem','C:/explicit/proxy.pem']);
  expect(collectNetworkDependencies({configuration,environmentId:'production',selection:{kind:'direct'}}).secretNeeds).toEqual([]);
});
it('rejects stale selections and invalid configurations before attempting secret or file access',()=>{
  expect(()=>collectNetworkDependencies({configuration,selection:{kind:'profile',profileId:'removed'}})).toThrow();
  expect(()=>collectNetworkDependencies({configuration:{...configuration,profiles:[{...configuration.profiles[0],password:'PRIVATE'}]}})).toThrow();
});
