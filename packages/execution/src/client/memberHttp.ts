import { z } from 'zod';
import { ExecutionHttpError } from './http.js';
import type { MemberSession } from './memberTypes.js';

export type MemberBinding = ReturnType<MemberSession['captureExecution']>;
async function waitForToken(signal: AbortSignal, token: Promise<string>): Promise<string> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([token, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
/** Bounds both control JSON and the member material data path before JSON parsing. */
export function createBoundedMemberFetch(fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input,init) => {
    const response=await fetcher(input,init);const signal=init?.signal;
    signal?.throwIfAborted();
    const limit=response.ok?64*1024*1024:4096;
    const declared=Number(response.headers.get('content-length'));
    if(Number.isFinite(declared)&&declared>limit){await response.body?.cancel();throw new Error('execution-response-too-large');}
    if(!response.body)return response;
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    const abort=()=>{void reader.cancel(signal?.reason).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    try{
      while(true){signal?.throwIfAborted();const part=await reader.read();signal?.throwIfAborted();if(part.done)break;
        if(part.value.byteLength>limit-size){await reader.cancel();throw new Error('execution-response-too-large');}
        size+=part.value.byteLength;chunks.push(part.value);
      }
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
    }finally{signal?.removeEventListener('abort',abort);reader.releaseLock();}
  };
}
/** Canonical member control requests; never retries an uncertain operation. */
export function createMemberExecutionRequest(binding: Pick<MemberBinding,'serverId'|'token'|'assertCurrent'>, fetcher: typeof fetch = globalThis.fetch, parentSignal?: AbortSignal, options?: { errorCodes: readonly string[] }) {
  const base=new URL(binding.serverId);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('execution-requires-https');
  const boundedFetch=createBoundedMemberFetch(fetcher);
  const finiteErrorCodes = new Set(options?.errorCodes);
  return async function request<T>(method: string, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    binding.assertCurrent();
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(new Error('execution-control-timeout')), 120000);
    try {
      signal.throwIfAborted();
      const token = await waitForToken(signal, Promise.resolve(binding.token()));
      if(!token||/[\r\n]/.test(token))throw new Error('missing-or-invalid-control-identity');
      binding.assertCurrent(); signal.throwIfAborted();
      const response = await boundedFetch(`${base.href.replace(/\/$/,'')}/${path}`, { method, redirect: 'error', cache: 'no-store', signal, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      // A denied response invalidates the profile; preserve only its bounded, safe error below.
      const authenticationDenied = response.status === 401 || response.status === 403;
      signal.throwIfAborted(); if (!authenticationDenied) binding.assertCurrent();
      let raw:unknown;
      try{raw=response.status===204?undefined:await response.json();}catch{throw new Error('execution-invalid-response');}
      signal.throwIfAborted(); if (!authenticationDenied) binding.assertCurrent();
      if (!response.ok) {
        const code = typeof raw === 'object' && raw !== null && 'code' in raw && typeof raw.code === 'string' && (/^[a-z][a-z0-9_-]{0,95}$/.test(raw.code) || (!authenticationDenied && finiteErrorCodes.has(raw.code))) ? raw.code : 'execution-request-failed';
        throw new ExecutionHttpError(response.status, code);
      }
      return schema.parse(raw);
    } finally { clearTimeout(timeout); }
  };
}
