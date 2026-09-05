import { ProtocolSchema, type Protocol } from "../domain/model.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { ExecutableRequest, ProtocolClient } from "../plugin/types.js";

/**
 * 已纳入的协议值（M5：http/websocket/soap；gRPC/MQTT 推迟，进枚举即 fail-fast）。
 * 由 ProtocolSchema 派生：枚举扩值时 fail-fast 集合自动跟随，杜绝两处漂移。
 */
export const KNOWN_PROTOCOLS = ProtocolSchema.options;

/**
 * 请求的有效协议（D5）：未携带 protocol 字段的旧形状请求视为 http——
 * 注册面（getProtocol/canHandle）与执行面（runner）统一走此口径，缺省逻辑单点收口。
 */
export function protocolOf(request: Pick<ExecutableRequest, "protocol">): Protocol {
  return request.protocol ?? "http";
}

/** canHandle 助手：客户端按协议显式匹配（D5），替代 URL 嗅探。 */
export function canHandleProtocol(request: Pick<ExecutableRequest, "protocol">, protocol: Protocol): boolean {
  return protocolOf(request) === protocol;
}

/** 按协议从注册中心解析客户端；未知协议或无承接者 → 明确错误（fail-fast，不悬挂）。 */
export function resolveProtocolClient(registry: PluginRegistry, request: ExecutableRequest): ProtocolClient {
  const protocol = protocolOf(request);
  if (!(KNOWN_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw new Error(`未知协议: ${protocol}（当前支持: ${KNOWN_PROTOCOLS.join("/")}）`);
  }
  const client = registry.getProtocol(request);
  if (!client) {
    throw new Error(`无可用协议客户端承接 ${protocol} 请求 ${request.url}`);
  }
  return client;
}
