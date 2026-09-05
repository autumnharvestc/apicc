/**
 * AI 频道入参/出口契约（M6-C 任务 2，规格 §2 D2/D4）。
 * 类型收敛（multi-protocol 先例）：**AiSuggestedCase 以 core 导出为单一事实源**
 * （`import type { AiSuggestedCase } from "@apicc/core"`，带本地生成的 id）——任务 1 的
 * fixture 契约（无 id 的本地形状 + 固定建议数据）随真链路接入收敛删除；桌面侧只保留
 * 频道定位的入参/出口形状。key 明文永不回传渲染层（出口只含 hasKey，裁定②）。
 */

/** ai:save-config 入参：key 省略或空串 = 保持既有 key 不变（key 只进 main 安全存储）。 */
export interface AiSaveConfigInput { baseUrl: string; model: string; apiKey?: string }

/** ai:get-config / ai:save-config 出口：key 以 hasKey 表达，不回传明文（裁定②）。 */
export interface AiKeyStatus { hasKey: boolean }

/**
 * ai:suggest 入参（任务 2 真链路）：apiId 供 main 定位接口定义；baseUrl/model 为渲染层
 * 已保存配置（localStorage，非敏感）随调用携带，main 与 safeStorage key 合成 provider 配置。
 */
export interface AiSuggestInput { apiId: string; baseUrl: string; model: string }

/** ai:test-config 入参：轻量探测目标端点（渲染层已保存配置；key 仍取自 main 安全存储）。 */
export interface AiTestConfigInput { baseUrl: string; model: string }

/** ai:test-config 出口：resolve 即连通/鉴权/响应面可用（失败以可读错误抛出）。 */
export interface AiTestConfigResult { ok: true }
