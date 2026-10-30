import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {NetworkConfigurationSchema} from '@apicc/core/schema';
const origins=JSON.parse(readFileSync(new URL('../../../server/src/test/resources/scheduling/origins.json',import.meta.url),'utf8')) as Array<{value:string;proxy:boolean;tls:boolean}>;
it.each(origins)('the shared origin sample agrees with the actual Core schema: $value',sample=>{
  const profile={id:'p',name:'Profile',targetTlsBindings:[]};
  const configuration={formatVersion:1,projectSelection:{kind:'profile',profileId:'p'},environmentSelections:[]};
  expect(NetworkConfigurationSchema.safeParse({...configuration,profiles:[{...profile,kind:'proxy',proxyUrl:sample.value}]}).success).toBe(sample.proxy);
  expect(NetworkConfigurationSchema.safeParse({...configuration,profiles:[{...profile,kind:'direct',targetTlsBindings:[{origin:sample.value,tls:{}}]}]}).success).toBe(sample.tls);
});
