# Assembly Engine

当前开发指南：[`docs-internal/architecture/DEVELOPMENT_GUIDE.md`](../../docs-internal/architecture/DEVELOPMENT_GUIDE.md)

## 当前职责

- Three.js 板件和孔洞网格；
- 正面、背面、自由相机和视角保持；
- 配件拖放、选中、删除、移动和手动旋转；
- 圆孔/长圆孔竖直定向吸附、孔位占用、接触面和下滑锁止距离；
- 2D/3D 孔位状态同步。
- 标定器 X/Y/Z 旋转环、固定几何枢轴、15° 刻度吸附和相机保持；
- 配件新增/移动/删除只刷新装配，不触发 Split Worker。

## 当前实现

`components/viewport/Viewport3D.tsx`、`utils/boardMesh.ts`、`boardFactory.ts`、`assemblySnap.ts`、`assemblySide.ts`、`viewportCamera.ts`。

配件命令通过 `Command.affectsSketch = false` 与草图/分割命令隔离；修改装配逻辑时必须保持这一边界。标定模型和配件模型的局部锚点使用毫米坐标，正式板长孔固定为竖直 `[0,1]`。标定器用板面薄 Box 和安装柱端面 `profile` 做代理碰撞，自动执行“沿板面法向插入→`contactZ` 碰板停止→按 `slideY` 向下碰底停止”；纯圆孔紧固件的下滑量为 0。默认界面只保留定位、自动检测和保存，分步与数值覆盖位于高级设置。正背面装配由 `assemblySide.ts` 统一翻转法向、长轴和接触深度。

选孔与装配是两个显式阶段：新增锚点不播放动画，只有“孔位选择完成”才触发一次。首孔自动完成法向/长孔轴定向；接触面射线识别失败时回退手动；上下手性由 180° 翻转按钮或高级 XYZ 调整解决。
