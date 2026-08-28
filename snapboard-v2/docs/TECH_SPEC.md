# SnapBoard v2 当前技术规格

更新时间：2026-08-26  
完整说明见 [`PROJECT_DOCUMENTATION.md`](PROJECT_DOCUMENTATION.md)。本文只保留架构和接口摘要。

## 1. 技术栈

| 层 | 实现 |
|---|---|
| 前端 | React 19、TypeScript 6、Vite 8 |
| 2D | Canvas 2D 自研编辑器 |
| 约束 | `@salusoft89/planegcs` WASM + 正交快速求解 |
| 3D | Three.js r185、WebGL、OrbitControls、Raycaster |
| 后处理 | EffectComposer、OutlinePass、OutputPass |
| 状态 | Zustand 5 + Command undo/redo |
| 几何 | `polygon-clipping`、Three.js Shape/Path/ExtrudeGeometry |
| 3MF | `fflate` + 自研 OPC/3MF Core 写出 |
| 本地存储 | File System Access API + IndexedDB |
| 开发 API | Vite middleware；不是生产云后端 |

## 2. 模块边界

- `src/App.tsx`：站点和设计器路由；
- `src/components/designer/DesignerApp.tsx`：工作区布局、快捷键和状态栏；
- `src/components/toolbar/Toolbar.tsx`：绘图工具、文件、分割、视图和导出；
- `src/store/useAppStore.ts`：`project`、`boards`、`placedParts`、`splitConfig`、`splitResult`；
- `src/hooks/useSketchTool.ts`：2D 绘图、命中、尺寸和修剪；
- `src/utils/pegboardSplit.ts`：孔位、正交切分、边缘融合、热床旋转；
- `src/utils/panelBoolean.ts`：板件内孔和切口布尔；
- `src/utils/boardMesh.ts`：预览和制造板件实体网格；
- `src/components/viewport/Viewport3D.tsx`：场景、相机、灯光、配件预览和吸附；
- `src/components/texture/TextureStudio.tsx`：纹理源、PETG LUT、调色和图片定位；
- `src/utils/slotAxisProbe.ts`：长圆孔安装柱/板孔端面长轴探测；
- `src/utils/mountAxis.ts`：消除网格环形采样造成的小角度主轴抖动；
- `src/utils/assemblySide.ts`：固定视角优先、自由视角按相机 Z 判断正背装配面；
- `src/utils/mountCalibrationRepair.ts`：恢复旧版被误记为圆孔的接触面数据；
- `scripts/part-category-rules.mjs`：Vite 与同步器共享的 8 类目录词表；
- `src/utils/projectFile.ts`：项目 schema、文件选择器、本地目录和 API 基址；
- `src/utils/export3mf.ts`：制造网格、排盘、3MF XML/ZIP 和闭合校验；
- `src/components/sidebar/PartLibraryPanel.tsx`：配件库浏览、吸顶头部、排序/自定义顺序与批量操作；
- `vite.config.ts`：资源包同步、配件导入/标定/批处理（`/api/part-library/batch`）和本地项目库 API。

## 3. 几何事实

- 草图内部为 Canvas 世界坐标；`pixelToMM` 转换为毫米；分割器使用 Y 向上工程坐标；
- 外轮廓支持矩形、L 型、阶梯型和正交多边形；内轮廓可为圆、槽、多边形和含弧轮廓；
- 长圆孔为 5×15 mm 全局错列晶格；B 相横向相位为工程 SVG 标定值 22.2648 mm；边缘候选孔默认 φ5，底边中心距严格为 10 mm；
- `knocked=true` 才是贯通孔，未确认候选位置只显示预览虚线；
- `printRotation` 只用于制造排盘，不改写设计坐标；
- 预览曲线较轻量，制造导出使用 48 段曲线和约 0.35 mm 倒角；
- 有纹理制造件支持 4 mm 基层 + 顶部承托模具 + 5/6/8 层 PETG 光学叠色，或 0.4–2 mm 单材质 PETG 质感贴面；
- 复合板只在最外侧生成上下对称倒角，拼接面保持平直；细磨砂导出通过 z 翻转贴合纹理 PEI，不使用 fuzzy skin；
- Bambu 工程耗材类型为 PETG，默认使用 PETG HF 温度和材料 profile；
- Bambu 全局 process 使用结构基材参数（0.28mm、2 壁、15% gyroid、0.6mm 顶底壳）；0.6mm 承托/单材质贴面使用 0.28mm，Lumina 光学 part 使用 0.08mm、100% 和慢速。Lumina 朝下时首层为 0.08mm，其他方案首层约 0.25mm；
- 彩色版画与质感贴面均由一个父对象的 `<components>` 绑定全部制造层；纹理 PEI 方案把装饰面翻到 z=0，避免 fuzzy skin 破坏孔壁；
- 板面图片交互通过 Three.js Raycaster 命中装配平面，拖动修改 `offsetX/offsetY`，滚轮修改 `scale`；
- 导出前每条无向边必须恰好由两个三角形共享，否则阻止导出。
- `PartMountAnchor.axis` 与 `AssemblyTarget.axis` 做平行约束，缺失旧轴向时必须重新标定；
- `occupiedIds` 在正背面共用，自动装配使用幂等 `openEdgeHole` 打通候选圆孔；
- `contactZForSide` 负责接触面正背面翻转，装配 Z 位移优先按接触面计算。
- 同一标定默认允许双面装配：正背面锁定视角覆盖自动判断，自由视角以板厚中面为界自动选择装配侧。
- 第二栏主工作区状态直接写入 `splitOptionsOpen / partsOpen / textureStudioOpen`：分割同步切换 2D，配件与纹理同步切换 3D，并通过布局事件展开右栏、收起左栏。右栏为全高整列，业务工作区一级入口在其顶部 tab 条；2D/3D 滑块开关位于轮廓类型卡右侧，只改 `viewMode`。
- 左/右/顶三侧收起态统一为玻璃细带 + 悬停玻璃滑出（`workspace-rail` / `.tb.is-collapsed`，整条可点击展开）；配件库与分割结果区采用吸顶玻璃头部，滚动内容从玻璃下模糊经过。
- 标定器与拖拽预览统一用面内胶囊几何表示 `slot`；接近 X/Y 主轴的采样结果会归正，无完整 fit 时只显示最近一个兼容引导孔。

## 4. 文件接口

- `.snapboard`：`format = snapboard-project`、`schemaVersion = 1`，可继续编辑；
- 板件清单 JSON：`format = snapboard-manufacturing`，保留为毫米制造接口；
- 3MF：标准 Core 模型 + `Metadata/model_settings.config` 多盘实例映射；
- Bambu `plater_id` 写入 `1..N`，对象和实例 ID 必须有效、唯一、数量一致；
- 预览虚线、标签、相机和材质不进入制造网格。

## 5. 存储接口

本地默认 API：

```text
POST /api/project-library/save?filename=项目.snapboard
GET  /api/project-library/list
GET  /api/project-library/open?filename=项目.snapboard
POST /api/project-library/export?filename=项目.3mf
```

云端通过 `VITE_PROJECT_STORAGE_API_BASE` 替换 API 基址。生产服务还需要认证、项目权限、对象存储、版本冲突和数据库索引；本地目录句柄仅适用于浏览器本地工作流。

## 6. 验证命令

```bash
npm run build
npm run lint
node .tmp-3d-test/verify-manufacturing-export.mjs
node .tmp-3d-test/verify-lumina-performance.mjs
node .tmp-3d-test/verify-lumina-mask-export.mjs
node .tmp-3d-test/verify-texture-direct-manipulation.mjs
node .tmp-3d-test/verify-consumer-layout.mjs
npm run verify:parts
npm run verify:assembly
node .tmp-3d-test/verify-hole-open-store.mjs
```

不要再使用旧字段 `maxPieceSize`、`holeRange`、`Connector male/female`，也不要把候选孔描述为薄盖或凹槽。它们不属于当前运行时制造语义。
