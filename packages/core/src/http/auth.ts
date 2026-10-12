import type { AuthProvider } from "../plugin/types.js";
import type { RuntimeAuth } from "../request/materialize.js";

type AppliedAuth = Exclude<RuntimeAuth, { kind: "none" }>;

function requireKind<K extends AppliedAuth["kind"]>(auth: AppliedAuth, kind: K): Extract<AppliedAuth, { kind: K }> {
  if (auth.kind !== kind) throw Object.assign(new Error(`认证提供方 ${kind} 收到 ${auth.kind}`), { caseFailureKind: "config" as const });
  return auth as Extract<AppliedAuth, { kind: K }>;
}

export const builtinAuthProviders: AuthProvider[] = [
  {
    type: "bearer",
    apply(req, auth) {
      const bearer = requireKind(auth, "bearer");
      req.headers["Authorization"] = `Bearer ${bearer.token}`;
    },
  },
  {
    type: "basic",
    apply(req, auth) {
      const basic = requireKind(auth, "basic");
      req.headers["Authorization"] = `Basic ${Buffer.from(`${basic.username}:${basic.password}`).toString("base64")}`;
    },
  },
  {
    type: "apikey",
    apply(req, auth) {
      const apiKey = requireKind(auth, "apikey");
      if (apiKey.placement === "query") {
        req.query.push({ key: apiKey.name, value: apiKey.value, enabled: true });
      } else {
        req.headers[apiKey.name] = apiKey.value;
      }
    },
  },
];
