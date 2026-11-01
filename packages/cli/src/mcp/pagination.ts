import { randomUUID } from "node:crypto";
import type { McpPage, McpPageResult } from "./source.js";

export function pageLimit(page: McpPage): number {
  const limit = page.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("MCP 页 limit 范围为整数 1–200");
  return limit;
}

/** Private cursor state; caller text cannot forge source/member/project/revision/query bindings. */
export function createPager() {
  const cursors = new Map<string, { key: string; offset: number }>();
  return {
    page<T>(items: Iterable<T>, page: McpPage, key: string): McpPageResult<T> {
      const limit = pageLimit(page);
      const record = page.cursor ? cursors.get(page.cursor) : undefined;
      if (page.cursor && (!record || record.key !== key)) throw new Error("MCP cursor 已失效；请从首页重新读取");
      const offset = record?.offset ?? 0;
      const result: McpPageResult<T> = { items: [] };
      let index = 0, hasMore = false;
      for (const item of items) {
        if (index++ < offset) continue;
        if (result.items.length === limit) { hasMore = true; break; }
        result.items.push(item);
      }
      if (hasMore) {
        if (cursors.size >= 1000) cursors.delete(cursors.keys().next().value!);
        result.nextCursor = `cursor:${randomUUID()}`;
        cursors.set(result.nextCursor, { key, offset: offset + limit });
      }
      return result;
    },
    clear() { cursors.clear(); },
  };
}

/** Count before serialization, stopping as soon as the fixed output budget is exceeded. */
export function boundedJson(value: unknown, maxBytes = 128 * 1024): string {
  let remaining = maxBytes;
  const take = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) throw new Error("MCP 输出超过预算；请使用分页（limit/cursor）缩小选择");
  };
  const string = (text: string) => {
    take(2);
    for (const character of text) {
      const code = character.codePointAt(0)!;
      take(code >= 0xd800 && code <= 0xdfff ? 6 : code < 32 ? ("\b\t\n\f\r".includes(character) ? 2 : 6) : character === '"' || character === "\\" ? 2 : Buffer.byteLength(character));
    }
  };
  const count = (item: unknown, depth = 0): void => {
    if (depth > 100) throw new Error("MCP 输出嵌套超过预算；请缩小选择");
    if (typeof item === "string") { string(item); return; }
    if (Array.isArray(item)) { take(2); for (let i = 0; i < item.length; i++) { if (i) take(1); count(item[i] ?? null, depth + 1); } return; }
    if (item && typeof item === "object") {
      take(2); let first = true;
      for (const [key, child] of Object.entries(item)) {
        if (child === undefined) continue;
        if (!first) take(1); first = false; string(key); take(1); count(child, depth + 1);
      }
      return;
    }
    take(JSON.stringify(item ?? null).length);
  };
  count(value);
  return JSON.stringify(value);
}
