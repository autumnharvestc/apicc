import { Buffer } from "node:buffer";

export interface ProjectFileLocation {
  groupId: string;
  projectId: string;
}

export interface CollectionFileLocation extends ProjectFileLocation {
  collectionId: string;
}

export interface ApiFileLocation extends CollectionFileLocation {
  folderIds: readonly string[];
  apiId: string;
}

const UUID_PATTERN = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value;
}

function projectBase(location: ProjectFileLocation): string {
  return `groups/${requireUuid(location.groupId, "groupId")}/projects/${requireUuid(location.projectId, "projectId")}`;
}

function collectionBase(location: CollectionFileLocation): string {
  return `${projectBase(location)}/collections/${requireUuid(location.collectionId, "collectionId")}`;
}

function folderBase(location: CollectionFileLocation, folderIds: readonly string[]): string {
  let current = collectionBase(location);
  for (const [index, folderId] of folderIds.entries()) {
    current += `/folders/${requireUuid(folderId, `folderIds[${index}]`)}`;
  }
  return current;
}

function apiBase(location: ApiFileLocation): string {
  const parent = folderBase(location, location.folderIds);
  return `${parent}/apis/${requireUuid(location.apiId, "apiId")}`;
}

function encodeCasePart(value: string, label: string): string {
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new TypeError(`${label} cannot be used as a path segment`);
  }
  const bytes = Buffer.from(value, "utf8");
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) {
    throw new TypeError(`${label} must contain valid Unicode`);
  }
  return bytes.toString("hex");
}

function decodeCasePart(value: string): string | undefined {
  try {
    if (!/^(?:[0-9a-f]{2})*$/.test(value)) return undefined;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "hex"));
    if (Buffer.from(decoded, "utf8").toString("hex") !== value) return undefined;
    encodeCasePart(decoded, "case path value");
    return decoded;
  } catch {
    return undefined;
  }
}

export function workspaceFilePath(): string {
  return "apicc.workspace.yaml";
}

export function groupDirectoryPath(groupId: string): string {
  return `groups/${requireUuid(groupId, "groupId")}`;
}

export function groupMetadataFilePath(groupId: string): string {
  return `${groupDirectoryPath(groupId)}/group.yaml`;
}

export function projectDirectoryPath(groupId: string, projectId: string): string {
  return `${groupDirectoryPath(groupId)}/projects/${requireUuid(projectId, "projectId")}`;
}

export function projectMetadataFilePath(groupId: string, projectId: string): string {
  return `${projectDirectoryPath(groupId, projectId)}/project.yaml`;
}

export function collectionDirectoryPath(location: CollectionFileLocation): string {
  return `${projectBase(location)}/collections/${requireUuid(location.collectionId, "collectionId")}`;
}

export function collectionMetadataFilePath(location: CollectionFileLocation): string {
  return `${collectionDirectoryPath(location)}/collection.yaml`;
}

export function folderDirectoryPath(location: CollectionFileLocation, folderIds: readonly string[]): string {
  if (folderIds.length === 0) throw new TypeError("folderIds must identify a folder");
  return folderBase(location, folderIds);
}

export function folderMetadataFilePath(location: CollectionFileLocation, folderIds: readonly string[]): string {
  return `${folderDirectoryPath(location, folderIds)}/folder.yaml`;
}

export function apiDirectoryPath(location: ApiFileLocation): string {
  return apiBase(location);
}

export function apiContractFilePath(location: ApiFileLocation): string {
  return `${apiDirectoryPath(location)}/api.yaml`;
}

export function apiDesignFilePath(location: ApiFileLocation): string {
  return `${apiDirectoryPath(location)}/design.md`;
}

export function apiCasesDirectoryPath(location: ApiFileLocation): string {
  return `${apiDirectoryPath(location)}/cases`;
}

export function apiCaseIndexFilePath(location: ApiFileLocation): string {
  return `${apiCasesDirectoryPath(location)}/index.yaml`;
}

export function apiCaseFilePath(location: ApiFileLocation, caseId: string, scope?: string): string {
  const casePart = encodeCasePart(caseId, "caseId");
  const scopePart = scope === undefined ? "" : `.${encodeCasePart(scope, "scope")}`;
  return `${apiCasesDirectoryPath(location)}/${casePart}${scopePart}.yaml`;
}

export function isSafeCaseFileName(fileName: string): boolean {
  if (!fileName.endsWith(".yaml")) return false;
  const encodedIdentity = fileName.slice(0, -".yaml".length);
  const parts = encodedIdentity.split(".");
  if (parts.length > 2) return false;
  return parts.every((part) => decodeCasePart(part) !== undefined);
}

export function modelAssetFilePath(location: ProjectFileLocation, modelId: string): string {
  return `${projectBase(location)}/models/${requireUuid(modelId, "modelId")}.yaml`;
}

export type ComponentKindPath = "parameter" | "auth" | "response" | "example";

export function componentAssetFilePath(location: ProjectFileLocation, kind: ComponentKindPath, componentId: string): string {
  return `${projectBase(location)}/components/${kind}/${requireUuid(componentId, "componentId")}.yaml`;
}

export function writeJournalDirectoryPath(): string {
  return ".apicc/write-journal";
}

export function writerLockFilePath(): string {
  return ".apicc/write-lock";
}

export function validateRelativeFilePath(filePath: string): string {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\\") || filePath.includes("\0")) {
    throw new TypeError("Storage paths must be non-empty relative POSIX paths");
  }
  const segments = filePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new TypeError("Storage paths cannot contain empty or escaping segments");
  }
  return segments.join("/");
}
