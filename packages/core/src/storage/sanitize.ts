/**
 * 节点名净化（M9-A2）：实体名在本地文件存储中直接用作目录/文件名
 * （groups/<名>/projects/<名>/collections/<名>/apis/<名>），用户与导入器提供的
 * 名称可能含文件系统非法字符（如把 URL 粘进名称框 → `http://...` 在 Windows 上
 * mkdir 即 ENOENT）。统一在此净化：非法字符替换为 `-`、去首尾空白与结尾点、
 * 限长 80 字符、空结果回退「未命名」、Windows 保留设备名加前缀。
 * 接入点：desktop session 的 create 与 rename 系列、importProject、core 内置导入器
 * （openapi/collection-v2.1）的名称产出——插件导入器的产物由 importProject 深度
 * 净化兜底。
 */
const ILLEGAL_CHARS = /[/\\:*?"<>|\u0000-\u001f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_LENGTH = 80;
const FALLBACK = "未命名";

export function sanitizeNodeName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_CHARS, "-")
    .trim()
    .replace(/[.\s]+$/g, "")
    .slice(0, MAX_LENGTH)
    .trim();
  if (cleaned.length === 0) return FALLBACK;
  return WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}
