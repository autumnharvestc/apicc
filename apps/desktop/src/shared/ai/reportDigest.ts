/** Selection check only; it never grants report-read authority. Browser and main use the same bytes. */
export async function aiReportDigest(value: unknown): Promise<string> {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item !== null && typeof item === "object") return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(item);
  };
  const projection: unknown = JSON.parse(JSON.stringify(value));
  const bytes = new TextEncoder().encode(`apicc-ai-report-selection:v1\n${canonical(projection)}`);
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
}
