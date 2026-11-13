export interface OnlineWorkspaceActionTarget {
  baseUrl: string;
  workspaceId: string;
}

export type OnlineWorkspaceAction = "migrate" | "exit";

export function normalizeOnlineBaseUrl(baseUrl: string | null | undefined): string | undefined {
  return baseUrl?.trim().replace(/\/+$/, "") || undefined;
}
