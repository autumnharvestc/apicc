import type { AuthProvider } from "../plugin/types.js";

/** 整串 {{name}} 占位符（命名规则与 variables/resolver 一致）；解析失败保留原文。 */
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_.$-]+)\s*\}\}$/;

/** 仅整串 {{name}} 查变量（未知保留原文）；普通字面量不进变量解析，原样返回。 */
function resolveValue(value: string | undefined, getVar: (name: string) => string | undefined): string {
  if (value === undefined) return "";
  const m = WHOLE_PLACEHOLDER.exec(value);
  return (m && getVar(m[1])) ?? value;
}

export const builtinAuthProviders: AuthProvider[] = [
  {
    type: "bearer",
    apply(req, auth, getVar) {
      req.headers["Authorization"] = `Bearer ${resolveValue(auth.token, getVar)}`;
    },
  },
  {
    type: "basic",
    apply(req, auth, getVar) {
      const u = resolveValue(auth.username, getVar);
      const p = resolveValue(auth.password, getVar);
      req.headers["Authorization"] = `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
    },
  },
  {
    type: "apikey",
    apply(req, auth, getVar) {
      const key = resolveValue(auth.key, getVar);
      const value = resolveValue(auth.value, getVar);
      if (auth.placement === "query") {
        req.query.push({ key, value, enabled: true });
      } else {
        req.headers[key] = value;
      }
    },
  },
];
