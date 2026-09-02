// 应用图标程序化生成（M1 计划 2C 任务 3，素材合规约束 asset-license-compliance）：
//   - 输出 build/icon.png（512×512，canonical 源图标）与 build/icon.ico（win 多尺寸，
//     electron-builder 对 ico 同格式源直接取用、不再调用其图标转换工具集——该工具集
//     下载路径因上游 @electron/get 3.x 移除 ElectronDownloadCacheMode 导出而必崩，
//     见 electron-builder.yml 注释与本任务报告）。
//   - 构成：圆角方形背景（竖向琥珀渐变 #d97706 → #92400e，逐像素插值）
//     + 白色抽象几何标记（圆环 + 斜向圆角短棒，二者分离避免构成字母字形）。
//   - 纯数学绘制：圆角判定与所有形状均用有向距离场（rounded-rect SDF /
//     distance-to-segment / 圆环距离），按 0.5px 阈值做抗锯齿覆盖度混合；
//     各尺寸按比例缩放同一场景重新渲染。
//   - 无文字、无图片素材、无网络请求——素材 100% 本脚本程序化生成。
// 用法：pnpm -C apps/desktop gen:icon
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const BASE = 512;
const CORNER_RADIUS = 96; // 圆角方形背景的圆角半径（512 基准，px）

// 琥珀渐变端点（顶部 → 底部）
const GRADIENT_TOP = [0xd9, 0x77, 0x06];
const GRADIENT_BOTTOM = [0x92, 0x40, 0x0e];

// 白色抽象标记的几何定义（512 基准，单位 px，坐标原点左上角）
// 圆环：中心 + 中径 + 壁厚
const RING = { cx: 256, cy: 232, radius: 100, thickness: 44 };
// 斜向圆角短棒（胶囊体）：线段两端点 + 半径；与圆环保持分离，避免构成字母字形
const BAR = { x1: 176, y1: 428, x2: 316, y2: 384, radius: 32 };

const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 有向距离场 → 覆盖度（d<0 在内部；0.5px 过渡带做抗锯齿）。 */
const coverage = (d) => clamp01(0.5 - d);

/** 圆角方形的 SDF（正 = 外部，负 = 内部，单位 px），half 为半边长、cr 为圆角半径。 */
function roundedRectSDF(px, py, half, cr) {
  const qx = Math.abs(px - half) - (half - cr);
  const qy = Math.abs(py - half) - (half - cr);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - cr;
}

/** 圆环的 SDF：点到中径圆周的径向距离减去壁厚一半。 */
function ringSDF(px, py, ring) {
  return Math.abs(Math.hypot(px - ring.cx, py - ring.cy) - ring.radius) - ring.thickness / 2;
}

/** 点到线段的距离（distance-to-segment），减去棒半径即胶囊体 SDF。 */
function capsuleSDF(px, py, bar) {
  const vx = bar.x2 - bar.x1;
  const vy = bar.y2 - bar.y1;
  const wx = px - bar.x1;
  const wy = py - bar.y1;
  const len2 = vx * vx + vy * vy;
  const t = clamp01((wx * vx + wy * vy) / len2);
  return Math.hypot(wx - t * vx, wy - t * vy) - bar.radius;
}

/** 按 size 渲染图标（512 基准几何等比缩放），返回 pngjs PNG 实例。 */
function render(size) {
  const k = size / BASE;
  const half = size / 2;
  const corner = CORNER_RADIUS * k;
  const ring = { cx: RING.cx * k, cy: RING.cy * k, radius: RING.radius * k, thickness: RING.thickness * k };
  const bar = { x1: BAR.x1 * k, y1: BAR.y1 * k, x2: BAR.x2 * k, y2: BAR.y2 * k, radius: BAR.radius * k };

  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    // 渐变插值因子：按行线性过渡
    const t = y / (size - 1);
    const r = GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * t;
    const g = GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * t;
    const b = GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * t;

    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      const covBg = coverage(roundedRectSDF(x + 0.5, y + 0.5, half, corner));
      if (covBg <= 0) {
        // 背景外全透明；RGB 取当前行渐变色，避免缩放暗边
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = 0;
        continue;
      }
      // 白色标记覆盖度：圆环与斜棒的并集
      const px = x + 0.5;
      const py = y + 0.5;
      const covMark = clamp01(Math.max(coverage(ringSDF(px, py, ring)), coverage(capsuleSDF(px, py, bar))));
      png.data[idx] = r + (255 - r) * covMark;
      png.data[idx + 1] = g + (255 - g) * covMark;
      png.data[idx + 2] = b + (255 - b) * covMark;
      png.data[idx + 3] = 255 * covBg;
    }
  }
  return png;
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
mkdirSync(outDir, { recursive: true });

// —— icon.png：512×512 canonical 源图标 ——
writeFileSync(join(outDir, "icon.png"), PNG.sync.write(render(BASE)));
console.log(`图标已生成：${join(outDir, "icon.png")}（${BASE}x${BASE}）`);

// —— icon.ico：win 多尺寸（PNG 压缩条目，Vista+ 原生支持）——
// electron-builder 约定：win 打包发现 build/icon.ico 时直接内嵌 exe 资源（resedit 对
// PNG 条目按 RawIconItem 透传），不再走其图标转换工具集下载路径。
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const blobs = ICO_SIZES.map((s) => ({ size: s, png: PNG.sync.write(render(s)) }));
const headerSize = 6 + 16 * blobs.length;
const totalSize = headerSize + blobs.reduce((sum, e) => sum + e.png.length, 0);
const ico = Buffer.alloc(totalSize);
let off = 0;
ico.writeUInt16LE(0, off); off += 2; // reserved
ico.writeUInt16LE(1, off); off += 2; // type = icon
ico.writeUInt16LE(blobs.length, off); off += 2;
for (const e of blobs) {
  ico.writeUInt8(e.size >= 256 ? 0 : e.size, off); // 宽（0 表示 256）
  ico.writeUInt8(e.size >= 256 ? 0 : e.size, off + 1); // 高
  ico.writeUInt8(0, off + 2); // 调色板色数
  ico.writeUInt8(0, off + 3); // reserved
  ico.writeUInt16LE(1, off + 4); // planes
  ico.writeUInt16LE(32, off + 6); // bit count
  ico.writeUInt32LE(e.png.length, off + 8);
  ico.writeUInt32LE(headerSize + blobs.slice(0, blobs.indexOf(e)).reduce((s, x) => s + x.png.length, 0), off + 12);
  off += 16;
}
for (const e of blobs) {
  e.png.copy(ico, off);
  off += e.png.length;
}
writeFileSync(join(outDir, "icon.ico"), ico);
console.log(`图标已生成：${join(outDir, "icon.ico")}（${ICO_SIZES.join("/")}）`);
