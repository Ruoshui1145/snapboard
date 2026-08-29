# Assembly Engine

当前开发指南：[`docs-internal/architecture/DEVELOPMENT_GUIDE.md`](../../docs-internal/architecture/DEVELOPMENT_GUIDE.md)

## 当前职责

- Three.js 板件和孔洞网格；
- 正面、背面、自由相机和视角保持；
- 配件拖放、选中、删除、移动和手动旋转；
- 圆孔/长圆孔轴向吸附、孔位占用和接触面；
- 2D/3D 孔位状态同步。
- 标定器 X/Y/Z 旋转环、固定几何枢轴、15° 刻度吸附和相机保持；
- 配件新增/移动/删除只刷新装配，不触发 Split Worker。

## 当前实现

`components/viewport/Viewport3D.tsx`、`utils/boardMesh.ts`、`boardFactory.ts`、`assemblySnap.ts`、`assemblySide.ts`、`viewportCamera.ts`。

配件命令通过 `Command.affectsSketch = false` 与草图/分割命令隔离；修改装配逻辑时必须保持这一边界。标定模型和配件模型的局部锚点使用毫米坐标，正背面装配由 `assemblySide.ts` 统一翻转法向、长轴和 `contactZ`。
