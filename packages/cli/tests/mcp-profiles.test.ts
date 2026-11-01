import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loginMcpProfile, openMcpProfile, logoutMcpProfile } from "../src/mcp/profiles.js";
import { runCli } from "../src/main.js";
import { createDefaultRegistry } from "@apicc/core";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "apicc-mcp-profile-")); homes.push(home);
  const vault = new Map<string, string>(); const requests: Array<{ url: string; init?: RequestInit }> = [];
  let userId = "7"; let status = 200;
  const deps = { mcpHomeDir: home, mcpEnv: {}, mcpKeyringEntry: (_service: string, account: string) => ({ async getPassword() { return vault.get(account); }, async setPassword(value: string) { vault.set(account, value); }, async deleteCredential() { return vault.delete(account); } }),
    mcpFetch: (async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/auth/login")) return Response.json({ token: "SYNTHETIC_MEMBER_TOKEN", expiresAt: "2099-01-01T00:00:00Z", user: { id: "7", username: "member", displayName: "member", role: "USER" } });
      if (String(url).endsWith("/auth/logout")) return new Response(null, { status: 204 });
      return Response.json(status === 200 ? { id: userId, username: "member", displayName: "member", role: "USER" } : { code: "forbidden" }, { status });
    }) as typeof fetch };
  const login = () => loginMcpProfile({ id: "member-profile", server: "https://service.example/", username: "member", password: "SYNTHETIC_MEMBER_PASSWORD", scopes: [{ workspaceId: "1", groupId: "2", projectId: "3" }] }, deps);
  return { home, deps, requests, vault, login, setIdentity(id: string) { userId = id; }, setStatus(value: number) { status = value; } };
}

// Final I8: native parser/schema details must not cross the login error boundary.
it.each([
  { name: "malformed JSON", text: 'LEAK1234 malformed SYNTHETIC_LOGIN_RESPONSE_PRIVATE_FRAGMENT' },
  { name: "invalid login schema", text: JSON.stringify({ token: "SYNTHETIC_LOGIN_RESPONSE_PRIVATE_FRAGMENT", user: { id: { secret: "SYNTHETIC_LOGIN_RESPONSE_PRIVATE_FRAGMENT" } }, expiresAt: "2099-01-01T00:00:00Z" }) },
])("final I8 returns only a fixed safe category for $name", async ({ text }) => {
  const f = fixture(); let calls = 0;
  const mcpFetch: typeof fetch = async () => { calls++; return new Response(text); };
  const error = await loginMcpProfile({ id: "invalid-response", server: "https://service.example", username: "member", password: "synthetic", scopes: [{ workspaceId: "1", groupId: "2", projectId: "3" }] }, { ...f.deps, mcpFetch }).then(() => null, cause => cause as Error);
  expect.soft(error?.message).toMatch(/login-response-invalid/);
  expect.soft(`${error?.message}\n${error?.stack}`).not.toContain("SYNTHETIC_LOGIN_RESPONSE_PRIVATE_FRAGMENT");
  expect.soft(error?.message).not.toContain("LEAK1234");
  expect.soft(error).not.toHaveProperty("cause");
  expect(calls).toBe(1); expect(f.vault.size).toBe(0);
});

// Login must use a separate member credential and persist only an OS reference, never password/token JSON.
it("logs into an independent member profile and captures the canonical API binding without secret persistence", async () => {
  const f = fixture(); await f.login(); const opened = await openMcpProfile("member-profile", f.deps);
  expect(opened.profile.server).toBe("https://service.example");
  const binding = opened.session.captureExecution({ serverId: "https://service.example/api/v1", ownerId: "7", scope: { workspaceId: "1", groupId: "2", projectId: "3" } });
  expect(await binding.token()).toBe("SYNTHETIC_MEMBER_TOKEN");
  expect(new Headers(f.requests[0]!.init?.headers).has("authorization")).toBe(false);
  expect(f.requests[0]!.url).toBe("https://service.example/api/v1/auth/login");
  const configuration = readFileSync(join(f.home, ".apicc", "mcp", "profiles.json"), "utf8");
  expect(configuration).not.toContain("SYNTHETIC_MEMBER_TOKEN");
  expect(configuration).not.toContain("SYNTHETIC_MEMBER_PASSWORD");
});

// A valid token for a different member must never silently change the captured profile owner.
it("refuses a changed /me member instead of switching the profile identity", async () => {
  const f = fixture(); await f.login(); f.setIdentity("8");
  await expect(openMcpProfile("member-profile", f.deps)).rejects.toThrow(/identity|身份/);
});
// captureExecution cannot confer scopes absent from the explicit profile allowlist.
it("refuses a project scope outside the member profile allowlist", async () => {
  const f = fixture(); await f.login(); const opened = await openMcpProfile("member-profile", f.deps);
  expect(() => opened.session.captureExecution({ serverId: "https://service.example/api/v1", ownerId: "7", scope: { workspaceId: "1", groupId: "2", projectId: "99" } })).toThrow(/scope|作用域/);
});
// Reusing a captured binding after replacing its login must fail before a new request.
it("invalidates old member bindings after another login replaces the profile", async () => {
  const f = fixture(); await f.login(); const opened = await openMcpProfile("member-profile", f.deps);
  const binding = opened.session.captureExecution({ serverId: "https://service.example/api/v1", ownerId: "7", scope: { workspaceId: "1", groupId: "2", projectId: "3" } });
  await f.login(); expect(() => binding.assertCurrent()).toThrow(/changed|失效/);
});
// HTTP bootstrap would expose the password before the downstream HTTPS request factory can reject it.
it("rejects an HTTP login server before sending the password", async () => {
  const f = fixture();
  await expect(loginMcpProfile({ id: "member-profile", server: "http://service.example", username: "member", password: "SYNTHETIC_MEMBER_PASSWORD", scopes: [{ workspaceId: "1", groupId: "2", projectId: "3" }] }, f.deps)).rejects.toThrow(/HTTPS/);
  expect(f.requests).toEqual([]);
});

it("verifies login member through /me before saving a profile", async () => {
  const f = fixture(); f.setIdentity("8");
  await expect(f.login()).rejects.toThrow(/identity|身份/);
  expect(f.vault.size).toBe(0);
});
it("bounds a login response before JSON parsing and secret persistence", async () => {
  const f = fixture(); const mcpFetch: typeof fetch = async () => Response.json({ token: "x".repeat(70000), expiresAt: "2099-01-01T00:00:00Z", user: { id: "7", username: "member", displayName: "member", role: "USER" } });
  await expect(loginMcpProfile({ id: "bounded", server: "https://service.example", username: "member", password: "synthetic", scopes: [{ workspaceId: "1", groupId: "2", projectId: "3" }] }, { ...f.deps, mcpFetch })).rejects.toThrow(/budget|预算|too-large/);
  expect(f.vault.size).toBe(0);
});
it("does not accept a successful-looking login body carried by HTTP 401", async () => {
  const f = fixture(); const mcpFetch: typeof fetch = async () => Response.json({ token: "synthetic", expiresAt: "2099-01-01T00:00:00Z", user: { id: "7", username: "member", displayName: "member", role: "USER" } }, { status: 401 });
  await expect(loginMcpProfile({ id: "denied", server: "https://service.example", username: "member", password: "synthetic", scopes: [{ workspaceId: "1", groupId: "2", projectId: "3" }] }, { ...f.deps, mcpFetch })).rejects.toThrow(/401|登录/);
  expect(f.vault.size).toBe(0);
});
it("logs out the member profile and invalidates captured bindings", async () => {
  const f = fixture(); await f.login(); const opened = await openMcpProfile("member-profile", f.deps);
  await logoutMcpProfile("member-profile", f.deps);
  await expect(openMcpProfile("member-profile", f.deps)).rejects.toThrow(/不存在|登录/);
  expect(() => opened.session.captureExecution({ serverId: "https://service.example/api/v1", ownerId: "7", scope: { workspaceId: "1", groupId: "2", projectId: "3" } })).toThrow(/失效|changed/);
  expect(f.vault.size).toBe(0);
});

// Profile login is a separate command; its controlled input is never the MCP JSON-RPC stream.
it("accepts a separate controlled-stdin profile login command without a password argv", async () => {
  const f = fixture(); const logs: string[] = [];
  expect(await runCli(["--no-plugins", "mcp-profile", "login", "cli-member", "--server", "https://service.example", "--username", "member", "--workspace", "1", "--group", "2", "--project", "3", "--password-stdin"], createDefaultRegistry(), line => logs.push(line), { ...f.deps, mcpSecretInput: async () => "CONTROLLED_PASSWORD", loadPlugins: false })).toBe(0);
  const opened = await openMcpProfile("cli-member", f.deps);
  expect(opened.profile.memberId).toBe("7"); expect(logs.join("\n")).not.toContain("CONTROLLED_PASSWORD");
});

// An OS entry is an audience envelope, not an unscoped token string.
it.each(["server", "memberId", "generation"])("refuses a stored member token with a different %s audience", async field => {
  const f = fixture(); await f.login();
  const [ref, text] = [...f.vault][0]!; const envelope = JSON.parse(text); envelope[field] = "different"; f.vault.set(ref, JSON.stringify(envelope));
  await expect(openMcpProfile("member-profile", f.deps)).rejects.toThrow(/audience|受众/);
});
// Replacing an explicit process token must invalidate a captured source, not reuse the previous token.
it("invalidates a profile binding when its explicit process token changes", async () => {
  const f = fixture(); const mcpEnv = { MEMBER_TOKEN: "SYNTHETIC_MEMBER_TOKEN" };
  const deps = { ...f.deps, mcpEnv };
  await loginMcpProfile({ id: "env-member", server: "https://service.example", username: "member", password: "synthetic", scopes: [{ workspaceId: "1", groupId: "2", projectId: "3" }], tokenEnv: "MEMBER_TOKEN" }, deps);
  const opened = await openMcpProfile("env-member", deps);
  const binding = opened.session.captureExecution({ serverId: "https://service.example/api/v1", ownerId: "7", scope: { workspaceId: "1", groupId: "2", projectId: "3" } });
  mcpEnv.MEMBER_TOKEN = "REPLACED_MEMBER_TOKEN";
  expect(() => binding.assertCurrent()).toThrow(/changed|失效/); expect(f.vault.size).toBe(0);
});
// Local logout must still revoke old cursors/bindings when the remote token is already rejected.
it("invalidates the local profile even when remote authority has already expired at logout", async () => {
  const f = fixture(); await f.login(); const opened = await openMcpProfile("member-profile", f.deps); f.setStatus(401);
  await logoutMcpProfile("member-profile", f.deps).catch(() => {});
  expect(() => opened.session.captureExecution({ serverId: "https://service.example/api/v1", ownerId: "7", scope: { workspaceId: "1", groupId: "2", projectId: "3" } })).toThrow(/changed|失效/);
  expect(f.vault.size).toBe(0);
});

// The public captured profile must not allow a caller to expand the fixed in-memory allowlist.
it("does not grant extra scope after a caller mutates the captured profile view", async () => {
  const f = fixture(); await f.login(); const opened = await openMcpProfile("member-profile", f.deps);
  try { opened.profile.scopes.push({ workspaceId: "1", groupId: "2", projectId: "99" }); } catch { /* Frozen views may reject the mutation directly. */ }
  expect(() => opened.session.captureExecution({ serverId: "https://service.example/api/v1", ownerId: "7", scope: { workspaceId: "1", groupId: "2", projectId: "99" } })).toThrow(/scope|作用域/);
});
