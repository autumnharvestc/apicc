import { CookieJar } from "tough-cookie";

export interface HttpSession {
  getCookieHeader(url: string): Promise<string | undefined>;
  storeResponseCookies(url: string, rawHeaders: readonly (readonly [string, string])[]): Promise<void>;
  listCookies(): Promise<HttpCookieSummary[]>;
  clearCookies(): Promise<void>;
  close(): Promise<void>;
}

/** Cookie metadata safe for local UI inspection; values are deliberately never returned. */
export interface HttpCookieSummary {
  name: string;
  domain: string | null;
  path: string | null;
  expires: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
}

/** Create an in-memory cookie jar owned by one explicit run or virtual-user session. */
export function createHttpSession(): HttpSession {
  const jar = new CookieJar();
  let closed = false;
  return {
    async getCookieHeader(url) {
      if (closed) throw new Error("The HTTP session is closed.");
      const value = await jar.getCookieString(url);
      return value || undefined;
    },
    async storeResponseCookies(url, rawHeaders) {
      if (closed) throw new Error("The HTTP session is closed.");
      for (const [name, value] of rawHeaders) {
        if (name.toLowerCase() === "set-cookie") await jar.setCookie(value, url, { ignoreError: true });
      }
    },
    async listCookies() {
      if (closed) throw new Error("The HTTP session is closed.");
      const cookies = await jar.store.getAllCookies();
      return cookies.map((cookie) => ({
        name: cookie.key ?? "",
        domain: cookie.domain ?? null,
        path: cookie.path ?? null,
        expires: cookie.expires instanceof Date ? cookie.expires.toISOString() : null,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: typeof cookie.sameSite === "string" ? cookie.sameSite : null,
      }));
    },
    async clearCookies() {
      if (closed) throw new Error("The HTTP session is closed.");
      await jar.store.removeAllCookies();
    },
    async close() { closed = true; },
  };
}
