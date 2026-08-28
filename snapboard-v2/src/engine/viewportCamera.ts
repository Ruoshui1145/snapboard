// ============ 视口相机共享引用 ============
// 相机状态住在 SketchViewport2D 的 useState 里, 而命中/吸附阈值以"屏幕像素"定义,
// 需换算成世界单位使用 → 通过此模块共享当前 scale (由视口每帧同步)。

export const viewportCamera = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
}

/** 屏幕像素 → 世界单位 (除以缩放, 防止缩放下阈值失真) */
export const screenToWorld = (screenPx: number) => screenPx / Math.max(0.01, viewportCamera.scale)
