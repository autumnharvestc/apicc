import { ApiRequestSchema } from "../contract/request.js";
import {
  DebugCaseIdentitySchema,
  DebugHistoryRecordSchema,
  DebugIdentitySchema,
  DebugInvocationSchema,
  type DebugFieldState,
  type DebugHistoryRecord,
  type DebugInvocation,
} from "./model.js";

export function createDebugReplayInvocation(recordValue: DebugHistoryRecord): DebugInvocation {
  const record = DebugHistoryRecordSchema.parse(recordValue);
  const result = record.result;
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

export function restoreDebugHistoryExchange(recordValue: DebugHistoryRecord, exchangeOrder: number): DebugInvocation {
  const record = DebugHistoryRecordSchema.parse(recordValue);
  const result = record.result;
  const replay = result.replay;
  if (result.mode !== replay.mode) throw new TypeError("调试历史结果模式与捕获描述符模式不一致，不能恢复。");
  assertSafeIdentity(result.identityAvailable, replay.identityAvailable);
  if (!Number.isSafeInteger(exchangeOrder) || exchangeOrder < 1) throw new TypeError("History exchange order must be a positive integer.");
  const exchange = result.exchanges.find((item) => item.order === exchangeOrder);
  if (!exchange) throw new TypeError("所选调试历史交换不存在。");
  assertExchangeOwnership(result, replay, exchange);
  const intent = exchange.intent;
  if (!intent || (!intent.available && !intent.fields.some((field) => field.needsInput))) {
    throw new TypeError("所选调试历史交换没有可恢复的捕获参数。");
  }

  const identity = replay.mode === "request"
    ? DebugIdentitySchema.parse(replay.locator)
    : locatorFromCase(DebugCaseIdentitySchema.parse(replay.case));
  const request = ApiRequestSchema.parse(replay.requestTemplate ?? (replay.mode === "request" ? replay.request : undefined));
  assertTemplateAvailable(request);
  const fields = mergeFields(replay.fields, intent.fields);
  return DebugInvocationSchema.parse({
    mode: "request",
    locator: identity,
    ...(result.environmentId === undefined ? {} : { environmentId: result.environmentId }),
    ...(replay.settings === undefined ? {} : { settings: replay.settings }),
    parentHistoryId: record.historyId,
    request,
    parameters: intent.parameters,
    fields,
  });
}

function assertSafeIdentity(resultAvailable: boolean | undefined, replayAvailable: boolean | undefined): void {
  if (resultAvailable === false || replayAvailable === false) throw new TypeError("调试历史缺少安全身份，仍可查看但不能恢复或重放。");
}

function assertExchangeOwnership(
  result: DebugHistoryRecord["result"],
  replay: DebugHistoryRecord["result"]["replay"],
  exchange: DebugHistoryRecord["result"]["exchanges"][number],
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
