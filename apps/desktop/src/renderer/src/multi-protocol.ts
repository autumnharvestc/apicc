import type { ApiDefinition } from "@apicc/core";

/**
 * M5 规格 D2 契约 fixture（M5-B 任务 1，两阶段执行）：main 基线的 core
 * ApiDefinitionSchema 为 strict 且尚无多协议字段（protocol/message/envelope/
 * soapAction）——保存链路此时不接线（新字段过旧 schema 会被拒），桌面端先按
 * 规格形状自建本地扩展类型承载编辑缓冲；任务 2 同步 main（M5-A 合并）后由
 * core schema 正式承载并校验落盘往返，此类型届时收敛为 core 的 ApiDefinition。
 *
 * 旧数据零破坏：无 protocol 字段即 http（显示侧回退，不回写数据）。
 */
export type ProtocolKind = "http" | "websocket" | "soap";

export type MultiProtocolApi = ApiDefinition & {
  protocol?: ProtocolKind;
  /** websocket：连接后发送的文本帧模板（缺省仅连接，D2） */
  message?: string;
  /** soap：XML 报文模板（规格必填——本阶段不接线，任务 2 由 core schema 校验） */
  envelope?: string;
  /** soap：SOAPAction 头（可选，D2） */
  soapAction?: string;
};

/** 新建/旧数据默认协议（D2：protocol 缺省 http）。 */
export const DEFAULT_PROTOCOL: ProtocolKind = "http";
