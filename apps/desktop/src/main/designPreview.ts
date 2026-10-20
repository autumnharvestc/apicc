import {
  buildDocumentProjection,
  createProjectSnapshot,
  getSourceApiRevision,
  type ApiAsset,
  type ContractFolder,
  type ContractProject,
} from "@apicc/core";
import { ApiAssetSchema } from "@apicc/core/schema";
import { DesignPreviewResultSchema, type DesignPreviewInput, type DesignPreviewResult } from "../shared/design.js";
import type { ApiLocator } from "../shared/locations.js";
import type { createSession } from "./session.js";

type Session = ReturnType<typeof createSession>;

function diagnostic(
  code: string,
  path: string,
  message: string,
  ownerId?: string,
): DesignPreviewResult["diagnostics"][number] {
  return { severity: "error", code, path, message, lossy: false, ...(ownerId === undefined ? {} : { ownerId }) };
}

function conflict(
  input: DesignPreviewInput,
  code: Extract<DesignPreviewResult, { status: "conflict" }>["code"],
  sourceRoot?: string,
  currentSourceProjectRevision?: string,
): DesignPreviewResult {
  return DesignPreviewResultSchema.parse({
    status: "conflict",
    source: "draft",
    ...(sourceRoot === undefined ? {} : { sourceRoot }),
    locator: input.locator,
    sourceProjectRevision: input.sourceProjectRevision,
    ...(currentSourceProjectRevision === undefined ? {} : { currentSourceProjectRevision }),
    code,
    diagnostics: [diagnostic(
      code === "project-revision-changed" ? "DOCUMENT_PREVIEW_STALE_REVISION" : "DOCUMENT_PREVIEW_CONTEXT_CONFLICT",
      code === "project-revision-changed" ? "sourceProjectRevision" : code === "root-mismatch" ? "sourceRoot" : "locator",
      code === "project-revision-changed"
        ? "项目内容已变化，请重新读取后再预览。"
        : code === "root-mismatch"
          ? "工作区根目录已变化，请重新读取后再预览。"
          : "当前工作区中找不到该接口来源，请重新选择后再预览。",
      input.locator.apiId,
    )],
  });
}

function invalidDraft(
  input: DesignPreviewInput,
  sourceRoot: string,
  paths: string[],
): DesignPreviewResult {
  const uniquePaths = [...new Set(paths)].slice(0, 50);
  return DesignPreviewResultSchema.parse({
    status: "invalid",
    source: "draft",
    sourceRoot,
    locator: input.locator,
    sourceProjectRevision: input.sourceProjectRevision,
    diagnostics: uniquePaths.map((path) => diagnostic("DOCUMENT_PREVIEW_INVALID_DRAFT", path, "接口草稿字段无效。", input.locator.apiId)),
  });
}

function fieldPath(path: PropertyKey[]): string {
  return path.map((segment) => {
    if (typeof segment === "number") return `[${segment}]`;
    if (typeof segment === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(segment)) return segment;
    return "<field>";
  }).join(".");
}

function replaceLocatedApi(project: ContractProject, locator: ApiLocator, draft: ApiAsset): boolean {
  const collection = project.collections.find((candidate) => candidate.id === locator.collectionId);
  if (!collection) return false;

  let folder: ContractFolder | undefined;
  if (locator.folderIds.length > 0) {
    let siblings = collection.folders;
    for (const folderId of locator.folderIds) {
      folder = siblings.find((candidate) => candidate.id === folderId);
      if (!folder) return false;
      siblings = folder.folders;
    }
  }

  const assets = folder?.apis ?? collection.apis;
  const index = assets.findIndex((asset) => asset.contract.id === locator.apiId);
  if (index < 0) return false;
  assets[index] = draft;
  return true;
}

/** Build a read-only preview from a validated draft inside a clone of the current project. */
export function previewDesignDraft(session: Session, input: DesignPreviewInput): DesignPreviewResult {
  const sourceRoot = session.root ?? undefined;
  if (sourceRoot === undefined) return conflict(input, "workspace-unavailable");
  if (input.sourceRoot !== sourceRoot) return conflict(input, "root-mismatch", sourceRoot);

  let location: ReturnType<Session["locateApi"]>;
  try {
    location = session.locateApi(input.locator);
  } catch {
    return conflict(input, "locator-mismatch", sourceRoot);
  }
  if (!location) return conflict(input, "api-not-found", sourceRoot);

  const savedSnapshot = createProjectSnapshot(location.project);
  if (savedSnapshot.definitionRevision !== input.sourceProjectRevision) {
    return conflict(input, "project-revision-changed", sourceRoot, savedSnapshot.definitionRevision);
  }

  const parsedDraft = ApiAssetSchema.safeParse(input.assetDraft);
  if (!parsedDraft.success) {
    return invalidDraft(input, sourceRoot, parsedDraft.error.issues.map((issue) => fieldPath(issue.path)));
  }
  if (parsedDraft.data.contract.id !== input.locator.apiId) {
    return invalidDraft(input, sourceRoot, ["contract.id"]);
  }

  const candidate = structuredClone(savedSnapshot.project) as ContractProject;
  if (!replaceLocatedApi(candidate, input.locator, structuredClone(parsedDraft.data))) {
    return conflict(input, "api-not-found", sourceRoot, savedSnapshot.definitionRevision);
  }

  const candidateSnapshot = createProjectSnapshot(candidate);
  const projection = buildDocumentProjection(
    { ...candidateSnapshot, definitionRevision: savedSnapshot.definitionRevision },
    { kind: "apis", contractIds: [input.locator.apiId] },
  );
  return DesignPreviewResultSchema.parse({
    status: "ready",
    source: "draft",
    sourceRoot,
    locator: { ...input.locator, folderIds: [...input.locator.folderIds] },
    sourceProjectRevision: savedSnapshot.definitionRevision,
    sourceApiRevision: getSourceApiRevision(parsedDraft.data),
    projection,
    diagnostics: projection.diagnostics,
  });
}
