import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
it("implements all nine trusted-host-only methods as explicit unavailable promises in the in-memory adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "apicc-t9-memory-"));
  try {
    const api = createMemoryApi({ root });
    for (const method of ["aiSettingsRead", "aiSettingsWrite", "aiCatalogImport", "aiCatalogReload", "aiConnectionTest", "aiDiscover", "aiPrepareAssistance", "aiStart", "aiCancel"] as const) {
      expect(api[method], method).toBeTypeOf("function");
      await expect((api[method] as (input?: unknown) => Promise<unknown>)({})).rejects.toThrow(/可信桌面宿主/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
