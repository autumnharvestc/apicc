import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getCACertificates, type ConnectionOptions } from "node:tls";
import type { PreparedNetworkResolution } from "@apicc/core";
import type { SourceAddress, SourceHostOptions, SourceMaterialLease, SourceNetworkContext } from "./types.js";
import { SourceHostError } from "./limits.js";

export async function approvedAddress(url: URL, context: SourceNetworkContext, options: SourceHostOptions, signal: AbortSignal): Promise<SourceAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses: readonly SourceAddress[] = family ? [{ address: hostname, family: family as 4 | 6 }]
    : options.resolveAddresses ? await options.resolveAddresses(hostname, signal) : await lookup(hostname, { all: true, verbatim: true }) as SourceAddress[];
  if (!addresses.length || addresses.some(a => isIP(a.address) !== a.family || !context.approveDestination(url, a))) throw new SourceHostError("SYNC_NETWORK_DENIED");
  return { ...addresses[0]! };
}

export function connectionTLS(resolution: PreparedNetworkResolution, leaseTLS: SourceMaterialLease["tls"]): ConnectionOptions {
  const tls = resolution.targetTLS;
  if (!tls.verify) throw new SourceHostError("SYNC_TLS_POLICY_INVALID");
  const extraCA = [...tls.caCertificates, ...(leaseTLS?.caPem ? [leaseTLS.caPem] : [])];
  return {
    rejectUnauthorized: true,
    ...(extraCA.length ? { ca: [...getCACertificates("default"), ...extraCA] } : {}),
    ...(leaseTLS?.certPem ? { cert: leaseTLS.certPem } : tls.clientCertificates.length ? { cert: [...tls.clientCertificates] } : {}),
    ...(leaseTLS?.keyPem ? { key: leaseTLS.keyPem } : tls.clientPrivateKey ? { key: tls.clientPrivateKey } : {}),
    ...(leaseTLS?.keyPem || tls.clientKeyPassphrase === undefined ? {} : { passphrase: tls.clientKeyPassphrase }),
  };
}
