import { ApiRequestSchema } from "../contract/request.js";
import {
  DebugCaseIdentitySchema,
  DebugHistoryRecordSchema,
  DebugIdentitySchema,
  DebugProjectIdentitySchema,
  DebugInvocationSchema,
  type DebugFieldState,
  type DebugHistoryRecord,
  type DebugInvocation,
  type DebugResult,
  type DebugResultV1,
} from "./model.js";

type V1Record = Extract<DebugHistoryRecord, { formatVersion: 1 }>;
type V2Record = Extract<DebugHistoryRecord, { formatVersion: 2 }>;

export function createDebugReplayInvocation(recordValue: DebugHistoryRecord): DebugInvocation {
  const record = DebugHistoryRecordSchema.parse(recordValue);
  return record.formatVersion === 1 ? createV1ReplayInvocation(record) : createV2ReplayInvocation(record);
}

function createV1ReplayInvocation(record: V1Record): DebugInvocation {
  const { result } = record;
  const replay = result.replay;
  assertSafeIdentity(result.identityAvailable, replay.identityAvailable);

  if (result.mode === "request" && replay.mode === "request") {
    assertReady(replay.fields);
    if (!replay.available) throw new TypeError("该调试历史意图不可重放。");
    const locator = DebugIdentitySchema.parse(replay.locator);
    const request = ApiRequestSchema.parse(replay.requestTemplate ?? replay.request);
    assertTemplateAvailable(request);
    return DebugInvocationSchema.parse({
      mode: "request",
      locator,
      ...(result.environmentId === undefined ? {} : { environmentId: result.environmentId }),
      ...(replay.settings === undefined ? {} : { settings: replay.settings }),
      parentHistoryId: record.historyId,
      request,
      parameters: replay.parameters,
      fields: replay.fields,
    });
  }

  if (result.mode === "case" && replay.mode === "case") {
    // Case replay consumes current assets/data rows, not the captured template or row summaries.
    const identity = DebugCaseIdentitySchema.parse(replay.case);
    return DebugInvocationSchema.parse({
      mode: "case",
      locator: locatorFromCase(identity),
      case: identity,
      ...(result.environmentId === undefined ? {} : { environmentId: result.environmentId }),
      ...(replay.settings === undefined ? {} : { settings: replay.settings }),
      parentHistoryId: record.historyId,
    });
  }
  throw new TypeError("调试历史模式与捕获的安全意图不匹配，不能重放。");
}

function createV2ReplayInvocation(record: V2Record): DebugInvocation {
  const { result } = record;
  const replay = result.replay;
  assertSafeIdentity(result.identityAvailable, replay.identityAvailable);

  if (result.mode === "free" && replay.mode === "free") {
    assertReady(replay.fields);
    if (!replay.available) throw new TypeError("该调试历史意图不可重放。");
    const project = DebugProjectIdentitySchema.parse(replay.project);
    const draftId = replay.draftId;
    if (!draftId) throw new TypeError("调试历史缺少free请求草稿身份，不能重放。");
    assertFreeSourceMatches(result.source, project, draftId);
    const request = ApiRequestSchema.parse(replay.requestTemplate ?? replay.request);
    assertTemplateAvailable(request);
    return DebugInvocationSchema.parse({
      mode: "free",
      project,
      draftId,
      ...(result.environmentId === undefined ? {} : { environmentId: result.environmentId }),
      ...(replay.settings === undefined ? {} : { settings: replay.settings }),
      parentHistoryId: record.historyId,
      request,
      parameters: replay.parameters,
      fields: replay.fields,
    });
  }

  if (result.mode === "request" && replay.mode === "request") {
    assertReady(replay.fields);
    if (!replay.available) throw new TypeError("该调试历史意图不可重放。");
    const locator = DebugIdentitySchema.parse(replay.locator);
    if (result.source.sourceKind !== "asset" || !sameLocator(result.source.locator, locator)) {
      throw new TypeError("调试历史来源与请求描述符归属不匹配，不能重放。");
    }
    const request = ApiRequestSchema.parse(replay.requestTemplate ?? replay.request);
    assertTemplateAvailable(request);
    return DebugInvocationSchema.parse({
      mode: "request",
      locator,
      ...(result.environmentId === undefined ? {} : { environmentId: result.environmentId }),
      ...(replay.settings === undefined ? {} : { settings: replay.settings }),
      parentHistoryId: record.historyId,
      request,
      parameters: replay.parameters,
      fields: replay.fields,
    });
  }

  if (result.mode === "case" && replay.mode === "case") {
    const identity = DebugCaseIdentitySchema.parse(replay.case);
    if (result.source.sourceKind !== "asset" || !sameLocator(result.source.locator, locatorFromCase(identity))) {
      throw new TypeError("调试历史来源与用例描述符归属不匹配，不能重放。");
    }
    return DebugInvocationSchema.parse({
      mode: "case",
      locator: locatorFromCase(identity),
      case: identity,
      ...(result.environmentId === undefined ? {} : { environmentId: result.environmentId }),
      ...(replay.settings === undefined ? {} : { settings: replay.settings }),
      parentHistoryId: record.historyId,
    });
  }
  throw new TypeError("调试历史模式与捕获的安全意图不匹配，不能重放。");
}

export function restoreDebugHistoryExchange(recordValue: DebugHistoryRecord, exchangeOrder: number): DebugInvocation {
  const record = DebugHistoryRecordSchema.parse(recordValue);
  if (!Number.isSafeInteger(exchangeOrder) || exchangeOrder < 1) throw new TypeError("History exchange order must be a positive integer.");
  return record.formatVersion === 1
    ? restoreV1Exchange(record, exchangeOrder)
    : restoreV2Exchange(record, exchangeOrder);
}

function restoreV1Exchange(record: V1Record, exchangeOrder: number): DebugInvocation {
  const { result } = record;
  const replay = result.replay;
  if (result.mode !== replay.mode) throw new TypeError("调试历史结果模式与捕获描述符模式不一致，不能恢复。");
  assertSafeIdentity(result.identityAvailable, replay.identityAvailable);
  const exchange = result.exchanges.find((item) => item.order === exchangeOrder);
  if (!exchange) throw new TypeError("所选调试历史交换不存在。");
  assertV1ExchangeOwnership(result, replay, exchange);
  const intent = exchange.intent;
  if (!intent || (!intent.available && !intent.fields.some((field) => field.needsInput))) {
    throw new TypeError("所选调试历史交换没有可恢复的捕获参数。");
  }
  const identity = replay.mode === "request"
    ? DebugIdentitySchema.parse(replay.locator)
    : locatorFromCase(DebugCaseIdentitySchema.parse(replay.case));
  const request = ApiRequestSchema.parse(replay.requestTemplate ?? (replay.mode === "request" ? replay.request : undefined));
  assertTemplateAvailable(request);
  return DebugInvocationSchema.parse({
    mode: "request",
    locator: identity,
    ...(result.environmentId === undefined ? {} : { environmentId: result.environmentId }),
    ...(replay.settings === undefined ? {} : { settings: replay.settings }),
    parentHistoryId: record.historyId,
    request,
    parameters: intent.parameters,
    fields: mergeFields(replay.fields, intent.fields),
  });
}

function restoreV2Exchange(record: V2Record, exchangeOrder: number): DebugInvocation {
  const { result } = record;
  const replay = result.replay;
  if (result.mode !== replay.mode) throw new TypeError("调试历史结果模式与捕获描述符模式不一致，不能恢复。");
  assertSafeIdentity(result.identityAvailable, replay.identityAvailable);
  const exchange = result.exchanges.find((item) => item.order === exchangeOrder);
  if (!exchange) throw new TypeError("所选调试历史交换不存在。");
  assertV2ExchangeOwnership(result, replay, exchange);
  const intent = exchange.intent;
  if (!intent || (!intent.available && !intent.fields.some((field) => field.needsInput))) {
    throw new TypeError("所选调试历史交换没有可恢复的捕获参数。");
  }

  if (result.mode === "free" && replay.mode === "free") {
    const project = DebugProjectIdentitySchema.parse(replay.project);
    const draftId = replay.draftId;
    if (!draftId) throw new TypeError("调试历史缺少free请求来源，不能恢复。");
    assertFreeSourceMatches(result.source, project, draftId);
    const request = ApiRequestSchema.parse(replay.requestTemplate ?? replay.request);
    assertTemplateAvailable(request);
    return DebugInvocationSchema.parse({
      mode: "free",
      project,
      draftId,
      ...(result.environmentId === undefined ? {} : { environmentId: result.environmentId }),
      ...(replay.settings === undefined ? {} : { settings: replay.settings }),
      parentHistoryId: record.historyId,
      request,
      parameters: intent.parameters,
      fields: mergeFields(replay.fields, intent.fields),
    });
  }

  if (replay.mode === "free") throw new TypeError("调试历史模式不匹配，不能恢复。");
  const identity = replay.mode === "request"
    ? DebugIdentitySchema.parse(replay.locator)
    : locatorFromCase(DebugCaseIdentitySchema.parse(replay.case));
  const request = ApiRequestSchema.parse(replay.requestTemplate ?? (replay.mode === "request" ? replay.request : undefined));
  assertTemplateAvailable(request);
  return DebugInvocationSchema.parse({
    mode: "request",
    locator: identity,
    ...(result.environmentId === undefined ? {} : { environmentId: result.environmentId }),
    ...(replay.settings === undefined ? {} : { settings: replay.settings }),
    parentHistoryId: record.historyId,
    request,
    parameters: intent.parameters,
    fields: mergeFields(replay.fields, intent.fields),
  });
}

function assertV1ExchangeOwnership(
  result: DebugResultV1,
  replay: DebugResultV1["replay"],
  exchange: DebugResultV1["exchanges"][number],
): void {
  if (exchange.identityAvailable === false || exchange.case === undefined) {
    throw new TypeError("所选调试历史交换缺少安全身份，不能恢复。");
  }
  const exchangeCase = DebugCaseIdentitySchema.parse(exchange.case);
  if (replay.mode === "request") {
    const locator = DebugIdentitySchema.parse(replay.locator);
    if (result.locator !== undefined && !sameLocator(DebugIdentitySchema.parse(result.locator), locator)) {
      throw new TypeError("调试历史结果身份与请求描述符归属不匹配，不能恢复。");
    }
    if (exchangeCase.caseId !== "__debug_request__" || exchangeCase.scope !== "base" || !sameLocator(exchangeCase, locator)) {
      throw new TypeError("所选调试历史交换身份与请求描述符归属不匹配，不能恢复。");
    }
    return;
  }

  const caseIdentity = DebugCaseIdentitySchema.parse(replay.case);
  if (result.locator !== undefined && !sameLocator(DebugIdentitySchema.parse(result.locator), locatorFromCase(caseIdentity))) {
    throw new TypeError("调试历史结果身份与用例描述符归属不匹配，不能恢复。");
  }
  if (!sameLocator(exchangeCase, caseIdentity)
    || exchangeCase.caseId !== caseIdentity.caseId
    || exchangeCase.scope !== caseIdentity.scope) {
    throw new TypeError("所选调试历史交换身份与用例描述符归属不匹配，不能恢复。");
  }
}

function assertV2ExchangeOwnership(
  result: DebugResult,
  replay: DebugResult["replay"],
  exchange: DebugResult["exchanges"][number],
): void {
  if (exchange.identityAvailable === false || exchange.source.sourceKind === "unavailable") {
    throw new TypeError("所选调试历史交换缺少安全身份，不能恢复。");
  }
  if (result.mode === "free" && replay.mode === "free") {
    const project = DebugProjectIdentitySchema.parse(replay.project);
    const draftId = replay.draftId;
    if (!draftId || result.source.sourceKind !== "free") throw new TypeError("调试历史缺少free请求来源，不能恢复。");
    assertFreeSourceMatches(result.source, project, draftId);
    if (exchange.source.sourceKind !== "free" || exchange.source.draftId !== draftId
      || !sameProject(exchange.source.project, project)) {
      throw new TypeError("所选调试历史交换与free请求草稿归属不匹配，不能恢复。");
    }
    return;
  }

  if (result.source.sourceKind !== "asset" || exchange.source.sourceKind !== "asset") {
    throw new TypeError("所选调试历史交换与资产来源不匹配，不能恢复。");
  }
  const exchangeCase = exchange.source.case;
  if (replay.mode === "request") {
    const locator = DebugIdentitySchema.parse(replay.locator);
    if (!sameLocator(result.source.locator, locator)) {
      throw new TypeError("调试历史结果身份与请求描述符归属不匹配，不能恢复。");
    }
    if (exchangeCase.caseId !== "__debug_request__" || exchangeCase.scope !== "base" || !sameLocator(exchangeCase, locator)) {
      throw new TypeError("所选调试历史交换身份与请求描述符归属不匹配，不能恢复。");
    }
    return;
  }
  if (replay.mode === "case") {
    const caseIdentity = DebugCaseIdentitySchema.parse(replay.case);
    if (!sameLocator(result.source.locator, locatorFromCase(caseIdentity))) {
      throw new TypeError("调试历史结果身份与用例描述符归属不匹配，不能恢复。");
    }
    if (!sameLocator(exchangeCase, caseIdentity) || exchangeCase.caseId !== caseIdentity.caseId || exchangeCase.scope !== caseIdentity.scope) {
      throw new TypeError("所选调试历史交换身份与用例描述符归属不匹配，不能恢复。");
    }
    return;
  }
  throw new TypeError("调试历史模式与捕获描述符不匹配，不能恢复。");
}

function assertFreeSourceMatches(
  source: DebugResult["source"],
  project: ReturnType<typeof DebugProjectIdentitySchema.parse>,
  draftId: string,
): void {
  if (source.sourceKind !== "free" || source.draftId !== draftId || !sameProject(source.project, project)) {
    throw new TypeError("调试历史free来源与捕获描述符归属不匹配，不能恢复或重放。");
  }
}

function assertSafeIdentity(resultAvailable: boolean | undefined, replayAvailable: boolean | undefined): void {
  if (resultAvailable === false || replayAvailable === false) throw new TypeError("调试历史缺少安全身份，仍可查看但不能恢复或重放。");
}

function sameLocator(
  left: ReturnType<typeof DebugIdentitySchema.parse>,
  right: ReturnType<typeof DebugIdentitySchema.parse>,
): boolean {
  return left.workspaceId === right.workspaceId
    && left.groupId === right.groupId
    && left.projectId === right.projectId
    && left.collectionId === right.collectionId
    && left.apiId === right.apiId
    && left.folderIds.length === right.folderIds.length
    && left.folderIds.every((folderId, index) => folderId === right.folderIds[index]);
}

function sameProject(
  left: ReturnType<typeof DebugProjectIdentitySchema.parse>,
  right: ReturnType<typeof DebugProjectIdentitySchema.parse>,
): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

function assertReady(fields: readonly DebugFieldState[]): void {
  if (fields.some((field) => field.needsInput)) throw new TypeError("调试历史字段需要补齐后才能发送。");
}

function assertTemplateAvailable(request: ReturnType<typeof ApiRequestSchema.parse>): void {
  if (request.protocol.length === 0) throw new TypeError("调试历史缺少安全请求模板。");
}

function locatorFromCase(identity: ReturnType<typeof DebugCaseIdentitySchema.parse>) {
  return {
    workspaceId: identity.workspaceId,
    groupId: identity.groupId,
    projectId: identity.projectId,
    collectionId: identity.collectionId,
    folderIds: [...identity.folderIds],
    apiId: identity.apiId,
  };
}

function mergeFields(base: readonly DebugFieldState[], row: readonly DebugFieldState[]): DebugFieldState[] {
  const merged = new Map(base.map((field) => [field.path, field]));
  for (const field of row) merged.set(field.path, field);
  return [...merged.values()];
}
