# SnapBoard v2 项目详细文档

更新时间：2026-08-26  
文档定位：当前代码实现、数据流、文件接口和部署边界的交接文档。

> 本文描述“现在代码已经做了什么”。实验脚本、旧版模块和未来规划不会被当成当前功能。具体字段校验以 `src/types/geometry.ts`、`src/utils/projectFile.ts` 和 `src/utils/export3mf.ts` 为准。

## 1. 项目定位

SnapBoard 是一个面向 3D 打印洞洞板的浏览器设计工具，核心流程是：

```text
官网/社区
   ↓ /design
2D 草图与尺寸约束
   ↓ 自动分割
可打印板件、全局孔位、跨板孔与边缘融合
   ↓ 3D 预览
孔位确认、配件拖放、吸附与装配检查
   ↓ 文件
.snapboard 可编辑项目 + 3MF 制造文件
```

当前版本的重点不是把网页当成一个普通 CAD 画板，而是让同一份参数和几何状态同时驱动 2D、3D、分割和制造输出。

## 2. 当前状态概览

| 能力 | 当前状态 | 入口 |
|---|---|---|
| 2D 草图、直线/矩形/圆/弧/槽口/多边形 | 已实现 | `SketchViewport2D.tsx`、`useSketchTool.ts` |
| 智能尺寸、约束求解、撤销/重做 | 已实现 | `@salusoft89/planegcs`、Command |
| 正交板件自动分割与边缘融合 | 已实现 | `pegboardSplit.ts` |
| 2D/3D 孔位同步与候选孔虚线 | 已实现 | `SketchViewport2D.tsx`、`boardMesh.ts` |
| 3D 板件和配件装配预览 | 已实现 | `Viewport3D.tsx` |
| 本地 `.snapboard` 项目保存/打开 | 已实现 | `projectFile.ts`、Vite 本地 API |
| 用户自选本地工作目录 | 已实现 | File System Access API + IndexedDB |
| 多盘 3MF 导出 | 已实现 | `export3mf.ts` |
| Bambu Studio 盘号兼容校验 | 已实现 | `validateBambuPlateLayout()` |
| PETG 制造预设与温度 | 已实现 | `bambuPrinterPresets.ts`、`export3mf.ts` |
| Lumina PETG 黑白/RYBW/CMYW/5色/6色/8色 | 已实现 | `luminaLut.ts`、`public/lumina/luts/` |
| 顶部洞洞板模具分层 | 已实现 | `export3mf.ts` |
| 复合板父对象绑定与上下对称倒角 | 已实现 | `export3mf.ts`、3MF `<components>` |
| 基材/表层独立切片参数 | 已实现 | `export3mf.ts`、`model_settings.config` |
| Lumina 彩色版画 / PETG 质感贴面 | 已实现 | `TextureStudio.tsx`、`BoardTextureConfig` |
| 纹理工作室板面直接拖动/缩放 | 已实现 | `TextureStudio.tsx`、`Viewport3D.tsx` |
| 导出进度、取消和大板分段生成 | 已实现 | `Toolbar.tsx`、`export3mf.ts` |
| 左右栏靠边折叠/悬停展开 | 已实现 | `DesignerApp.tsx`、`App.css` |
| 8 类配件目录与双布局扫描 | 已实现 | `sync-part-library.mjs`、`part-category-rules.mjs` |
| 批量导入、Portal 弹窗与改名 | 已实现 | `PartImportDialog.tsx`、Vite API |
| 长孔轴向、全局占孔与 contactZ | 已实现 | `slotAxisProbe.ts`、`assemblySnap.ts` |
| 工作台布局: 右栏全高列 + 业务工作区 tab 一级入口 | 已实现 | `DesignerApp.tsx`、`RightSidebar.tsx` |
| 2D/3D 滑块开关 + 左/右/顶三侧玻璃滑出收起 | 已实现 | `Toolbar.tsx`、`App.css` |
| 配件库吸顶、资源序号、分类移动与删除 | 已实现 | `PartLibraryPanel.tsx`、`PartImportDialog.tsx`、`/api/part-library/batch` |
| 网页退出开发服务 | 已实现 | `/api/system/shutdown` |
| 云端保存 | 接口已预留，服务端未随本项目提供 | `VITE_PROJECT_STORAGE_API_BASE` |
| STEP/SLDPRT 浏览器直接编辑 | 未实现 | 后续 OpenCascade/WASM 方向 |

## 3. 运行环境

### 3.1 安装与启动

```bash
npm install
npm run dev       # 默认 http://localhost:5173
npm run build     # parts:sync + TypeScript + Vite production build
npm run lint      # oxlint
```

Windows 项目目录提供 `SnapBoard Studio.lnk` 和 `一键启动 SnapBoard.bat`。快捷方式会先检查依赖，再启动 `npm run dev -- --host 127.0.0.1`，轮询 `/design` 确认服务就绪后才打开浏览器；若 5173 已有可访问服务，则直接复用。

启动前会执行 `npm run parts:sync`，把项目内 `配件资源包/` 同步成网页运行时可读取的 `public/partLibrary/`。Vite 配置中的 `server.watch.ignored` 用于规避 Windows 原子保存临时目录触发的 EBUSY，不能随意删除。

### 3.2 页面路由

| 路由 | 页面 | 主要入口 |
|---|---|---|
| `/` | 产品首页 | `src/components/site/SiteApp.tsx` |
| `/community` | 社区方案 | `SiteApp.tsx` |
| `/guide` | 使用指南 | `SiteApp.tsx` |
| `/print` | 打印服务说明 | `SiteApp.tsx` |
| `/design` | 设计器 | `src/components/designer/DesignerApp.tsx` |

`src/App.tsx` 负责 History API 路由和设计器懒加载。

## 4. 技术栈与运行时分层

| 层 | 当前实现 | 责任 |
|---|---|---|
| 应用 UI | React 19 + TypeScript 6 | 页面、工具栏、侧栏和状态反馈 |
| 构建 | Vite 8 | 开发服务器、生产构建、开发期本地 API |
| 2D 绘图 | Canvas 2D 自研编辑器 | 点、边、轮廓、尺寸和交互命中 |
| 约束求解 | `@salusoft89/planegcs` WASM + 本地正交求解 | 尺寸约束和草图状态 |
| 3D | Three.js r185 + WebGL | 场景、网格、材质、灯光、射线拾取 |
| 3D 后处理 | `EffectComposer`、`OutlinePass`、`OutputPass` | 选中轮廓和显示质量 |
| 状态 | Zustand 5 | 当前工程、板件、配件、分割结果和 UI 状态 |
| 几何 | `polygon-clipping`、Three.js Shape/ExtrudeGeometry | 二维布尔与三维实体网格 |
| 文件压缩 | `fflate` | 3MF OPC/ZIP 容器 |
| 本地持久化 | Windows 文件系统 API + IndexedDB | 用户授权目录和项目文件句柄 |
| 开发期后端 | `vite.config.ts` 中间件 | 本地项目库和配件导入/标定 |

`@react-three/fiber` 和 `@react-three/drei` 属于依赖，但当前核心 `Viewport3D` 采用直接 Three.js 场景管理；不要把它描述成完全由 React Three Fiber 渲染。

## 5. 代码结构

```text
src/
├── App.tsx                         # 路由壳与懒加载
├── components/
│   ├── designer/DesignerApp.tsx   # 设计器三栏布局与状态栏
│   ├── toolbar/Toolbar.tsx         # 工具、文件、分割、视图切换
│   ├── sidebar/                    # 属性、分割引擎、配件库
│   ├── viewport/                   # 2D、3D、轮盘交互
│   └── site/                       # 首页和内容页
├── store/useAppStore.ts            # 唯一运行时工作区
├── hooks/useSketchTool.ts          # 2D 绘图状态机
├── commands/                       # 可撤销命令
├── types/geometry.ts               # 几何、工程、分割权威类型
├── utils/
│   ├── pegboardSplit.ts            # 分割和孔位
│   ├── panelBoolean.ts             # 内孔/切口布尔
│   ├── boardMesh.ts                # 预览与制造板件网格
│   ├── export3mf.ts                # 3MF 生成与网格校验
│   ├── luminaLut.ts                # PETG LUT 与叠色配方
│   ├── boardTexture.ts             # 纹理预处理和视觉映射
│   ├── projectFile.ts              # 项目文件、目录授权和本地 API
│   └── assemblySnap.ts             # 配件吸附
└── partLibrary/                    # 配件类型与资源包运行时类型
```

## 6. 运行时数据流

`useAppStore` 保存以下工作区数据：

- `project`：草图、轮廓、特征、材料和像素到毫米比例；
- `boards`：兼容早期演示板工作流的板对象；
- `placedParts`：已放置配件、参数、旋转和吸附结果；
- `splitConfig`：热床、孔位、板厚、倒角、间隙和推荐打孔选项；
- `splitResult`：源轮廓、分割板件、警告、覆盖率和时间戳；
- `undoStack/redoStack`：Command 对象，只存在于当前会话，不写入项目文件；
- `ui`：当前工具、选择、2D/3D 模式、侧栏折叠状态等临时界面状态。
- `boardTexture`：纹理源、图片映射、Lumina 建模模式、PETG LUT、调色和顶部模具厚度。

修改草图后会更新求解状态；修改分割参数或外轮廓后，分割结果按当前配置重新生成。加载项目会清空命令历史和临时选择，再计算约束状态。

## 7. 2D 几何与分割

### 7.1 坐标

草图内部使用 Canvas 世界坐标，`Project.config.pixelToMM` 负责像素到毫米换算。进入洞洞板分割时，Y 方向转换为工程坐标中的向上方向。板件、孔位和导出文件统一使用毫米。

### 7.2 轮廓

外轮廓可以是矩形、L 型、阶梯型和其他正交多边形；内轮廓可表示圆、普通多边形、槽口和带弧轮廓。`outer` 是板材实体边界，`inner` 是减材开孔。

### 7.3 自动分割

`pegboardSplit.ts` 负责：

1. 识别外轮廓和内孔；
2. 根据 `mx/my` 模数、最小板宽高和热床有效区域确定切分网格；
3. 在接缝处做边缘孔融合和跨板孔处理；
4. 保持长圆孔的全局错列相位，不按每块板重新起阵列；
5. 计算每块板的 `printRotation`，供热床排盘使用；
6. 生成警告、覆盖率和可制造板件列表。

分割算法输出的是制造语义，不是简单的矩形裁剪。`SplitPanel.contour` 和 `cutouts` 是实际制造轮廓，消费者不能仅凭 `w/h` 猜测实体形状。

### 7.4 孔位语义

- 长圆孔：默认 5×15 mm，全局错列晶格；B 相横向相位使用工程 SVG 标定值 22.2648 mm；
- 边缘候选圆孔：默认 φ5；底边孔中心严格距底边 10 mm；
- `knocked=true`：真实贯通孔；
- `knocked=false`：完整板面上的候选位置，只显示虚线；
- `manual=true`：用户对自动推荐结果的覆盖；
- 结构性边缘缺口：属于板件实际外轮廓，不允许被当成普通候选孔反复切换。

因此“虚线孔”不会生成薄盖、凹槽或浮动物体，也不会进入 3MF。只有用户确认或自动推荐的贯通孔才会切入实体。

## 8. 3D 渲染管线

`Viewport3D.tsx` 在浏览器中创建 Three.js 场景：

```text
Zustand 工作区
   ↓
generateBoardMesh / generateSplitPanelMesh
   ↓
Shape + Path + ExtrudeGeometry
   ↓
MeshStandardMaterial / LineDashedMaterial
   ↓
PerspectiveCamera + lights + GridHelper
   ↓
WebGLRenderer + OrbitControls + Raycaster
```

板件网格使用二维 `Shape/Path` 先表达外轮廓和真实通孔，再沿 Z 轴挤出板厚。实时预览使用较轻的曲线离散；制造导出使用 48 段曲线并加入约 0.35 mm 倒角，同时保持最终 Z 厚度精确等于配置的板厚。

3D 中的配件拖放通过相机射线与板面求交，先显示碳灰半透明模型；模型上的长圆孔锚点固定显示为胶囊、圆孔锚点显示为圆形。整组尚未匹配时只以金色显示最近一个兼容引导孔，匹配后改为绿色精确孔组，再根据孔型、轴向、占用和旋转限制完成吸附。选中对象通过后处理轮廓高亮。P1/P2 等标签、虚线孔和拖拽预览都标记为预览对象，不能污染制造网格。

## 9. 配件资源包与装配

资源包位于：

```text
配件资源包/<包名>/
├── pack.json
└── parts/<零件 ID>/
    ├── part.json
    ├── model.3mf / model.stl / model.glb
    ├── preview.glb
    └── source.step（可选归档）
```

`part.json` 描述名称、说明、类别、资源序号 `sortOrder`、模型格式、单位、朝向、打印模型和装配锚点。锚点类型为 `slot`、`round` 或 `either`，多锚点零件会整体匹配，不通过拉伸零件来凑孔距。`sortOrder` 为数值，越小越靠前；缺失时同步脚本按当前扫描顺序自动补写 10、20、30…，给后续插入预留间隔。

资源目录兼容两种布局：传统 `<包>/parts/<零件>/part.json`，以及大类根 `<大类>/<零件>/part.json`。8 个大类目录通过共享的 `scripts/part-category-rules.mjs` 分类；散放模型会拆成每文件一个零件目录。网页批量导入单文件上限 200 MB，单文件失败不会阻断后续文件。

配件库采用吸顶浏览：资源包摘要、导入区、排序工具栏与分类胶囊固定在上方玻璃层，只有零件列表滚动。排序提供「默认（资源序号）/ 名称 / 类别 / 模型格式 / 标定状态」五种模式与升降序切换；默认模式下拖动卡片左侧 ⠿ 手柄即可重排，结果通过 `POST /api/part-library/batch` 的 `reorder` 动作写回各零件 `part.json.sortOrder`。零件设置弹窗可编辑名称、说明、序号和分类位置，并提供永久删除；批量模式仍支持全选/清空/移动到分类/删除。`move-category` 会按目标布局（大类根直挂或 `我的配件/parts/`）移动目录并改写 `part.json.category`，完成后重同步索引并逐项回报失败。

分割/配件/纹理是右栏顶部同级的双层业务入口，标题下方显示当前状态或用途说明。第二工具栏提供紧凑的自动/取消分割按钮与独立 2D/3D 开关：选择分割进入 2D，选择配件或纹理进入 3D；之后仍可手动切换视图而不关闭当前右栏内容。

自定义图片在 3D 板面上采用“轻量交互、结束提交”：拖动或滚轮期间只移动/缩放图片范围虚线框，结束后一次性更新纹理参数和画布纹理，避免 `CanvasTexture` 边缘重复造成条纹拖影，也避免状态提交后先回旧位置再跳回新位置。虚线框表示原图在整板坐标中的完整覆盖范围，超出板面的内容也能被识别。

长圆孔锚点可保存局部安装面内单位向量 `axis`；装配求解要求旋转后的轴与板孔 `[0,1]` 满足 `|dot| ≥ 0.9`。缺少 `axis` 的旧标定会被标记为“待补长孔方向”，打开标定器后通过端面环形采样补算。所有已放置零件的 `targetIds` 汇总成正背面共享的占用集合；自动装配命中未开候选圆孔时执行幂等开孔。

`mount.contactZ` 表示零件局部贴板接触面的 Z。正面装配使用 `target.z - contactZ`，背面先翻转 `contactZ`；未设置时才回退到锚点平面。

同一套标定锚点可用于板件正反两面。锁定“正面/背面”视角时严格使用所选装配面；自由视角下根据相机相对板厚中面的位置实时判断当前面。背面装配会统一翻转锚点 X/Z、法向、长轴 X 分量和 `contactZ`，拖拽提示会显示当前为“正面”或“背面”。

标定器的接触面是独立定位项，不计入孔锚点。旧版曾把接触面误追加成最后一个圆孔；当前加载时只在“前序锚点共面、末项圆孔明显离面”的严格条件下自动恢复，并要求用户检查后保存。配件卡只有缩略图/正文属于拖拽区域，改名与标定按钮不会再触发浏览器卡片拖影。

开发期将资源包同步到 `public/partLibrary/`；零件库可导入用户的 3MF、STL、GLB 或 GLTF。缺少制造模型的零件可以在网页中预览，但 3MF 导出时会被跳过并给出警告。

## 10. 项目文件与保存位置

### 10.1 `.snapboard`

`.snapboard` 是 UTF-8 JSON，格式为 `snapboard-project`，当前 schema 为 1。它保存可继续编辑的工作区，不保存命令历史、相机、选择和临时渲染缓存。打开前会校验格式、版本、草图、板件、配件和分割结果。

### 10.2 三种本地保存路径

1. 开发环境默认项目库：`snapboard-v2/已保存项目/`；
2. 用户通过“保存位置”授权的本地目录：项目写入目录根，3MF 写入 `制造导出/`；
3. “另存为”系统文件选择器：只针对当前项目文件单独选择路径。

用户选中的目录句柄保存在 IndexedDB，页面刷新后会尝试恢复；浏览器可能要求重新授权。浏览器安全策略不允许网页读取用户磁盘的绝对路径，因此界面显示目录名和文件名，而不是伪造完整绝对路径。

### 10.3 本地开发 API

`vite.config.ts` 提供受限的项目库中间件：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/project-library/save?filename=...` | 写入 `.snapboard` |
| GET | `/api/project-library/list` | 列出项目库文件 |
| GET | `/api/project-library/open?filename=...` | 读取项目 |
| POST | `/api/project-library/export?filename=...` | 写入 `制造导出/` 下的 3MF |

服务端限制文件名字符、路径越界和请求体大小；这不是生产云服务，只是本地开发/测试适配层。

### 10.4 云端预留

设置：

```text
VITE_PROJECT_STORAGE_API_BASE=https://your-api.example.com/api/project-library
```

前端会把同样的 `save/list/open/export` 请求发到该基址。生产后端应补充身份认证、项目所有权、版本冲突、对象存储和数据库索引；浏览器目录授权只属于本地模式，不应被当成云端文件系统。

## 11. 3MF 制造导出

3MF 由 `fflate` 在浏览器端直接生成，核心文件包括：

- `[Content_Types].xml`；
- `_rels/.rels`；
- `3D/3dmodel.model`；
- `Metadata/model_settings.config`，用于 Bambu/Orca 多盘与实例映射。

导出流程：

1. 确认当前分割结果；
2. 生成板件制造网格；
3. 加载已放置配件的 `model.print`；
4. 相同制造几何复用一个 3MF object；
5. 按热床有效区域、间距、禁放区和旋转建议排盘；
6. 合并顶点、检查每条无向边恰好被两个三角形使用；
7. 校验盘号和对象实例映射；
8. 保存项目快照和 3MF。

制造输出不包含：2D 尺寸、P1/P2 标签、3D 虚线、相机、灯光、材质预览和拖拽辅助对象。

Bambu 的 `plater_id` 必须写为从 1 开始的连续盘号；对象/实例 ID 必须有效且唯一。旧版错误盘号生成的文件不能通过代码自动追溯修复，必须重新导出。

## 12. PETG、Lumina 与纹理工作室

当前制造默认使用 PETG，不再使用 PLA 模板：Bambu 工程写入 PETG HF 耗材配置，喷嘴温度 245°C，首层 230°C，热床 70°C。纹理工作室提供 PETG 校准 LUT：黑白、RYBW、CMYW、5 色扩展、6 色 Smart 1296 和 8 色 Max，并提供单材质质感贴面方案。

彩色版画板件的实体结构为：

```text
0 .. 4.0 mm       结构基层（内部拼接面平直，负责一侧外表面倒角）
4.0 .. optical    顶部洞洞板承托模具
optical .. 5.0   Lumina PETG 光学叠色层（5×0.08 或 6×0.08 mm）
```

上表是设计坐标中的逻辑层序。选择“细磨砂面”时，导出器会将整个复合板沿 Z 轴翻转，使装饰面落在 z=0、贴合纹理 PEI 热床；选择“普通顶面”则保持装饰面朝上。

顶部模具与原板共用轮廓 Shape，因此外圆角、槽孔、圆孔和内轮廓不会被彩色层覆盖。基材/表层之间保持平直拼接面，只在复合板最外侧生成倒角：基材负责一侧，表层负责另一侧，最终外缘和孔口上下对称。Bambu Studio 会按实际基础耗材显示白、红、黄、蓝等实体层，不模拟正面透光混色；网页 3D 预览负责显示最终观感。

质感贴面使用“普通 PETG 结构基材 + 0.4–2.0 mm 单耗材表层”。默认示例为普通白色 PETG 加浅绿色 PETG 大理石；材料名称、颜色、贴面厚度和基材填充率均写入工程。细磨砂不是通过 fuzzy skin 扰动孔壁，而是把装饰面翻到 z=0，贴合纹理 PEI 热床成型；也可切换为普通朝上顶面。

3MF 全局工艺以结构基材为准：0.28 mm 层高、2 道壁、0.6 mm 顶/底壳和默认 15% gyroid（可调 5–50%）。0.6 mm 承托层使用 0.28 mm；只有 Lumina 光学层在 `model_settings.config` 中单独覆盖为 0.08 mm、100% 填充和慢速。Lumina 装饰面朝下时首层也强制 0.08 mm，避免全局首层覆盖叠色；单材质贴面或普通基材首层约 0.25 mm，后续 0.28 mm。父对象通过 3MF `<components>` 引用全部层，移动父对象会带动所有层，不同材料仍可独立选择耗材槽。

纹理工作室分为：贴图纹理（内置图案经 Lumina 叠色）、材质纹理（4 mm 普通基材 + 约 1 mm 高级 PETG）和自定义图片（导入框与高保真/像素/SVG 模式并排）。图片在 3D 板面直接拖动可更新全局偏移，滚轮按图片中心连续缩放；提交新比例前保留临时纹理矩阵，避免“缩放→复位→再次缩放”的闪跳。大板导出使用板件栅格掩膜和距离场，逐段让出主线程并支持取消。

## 13. UI 操作入口

顶部第一行是绘图工具和二级模式；第二行按以下顺序组织：文件、操作历史、轮廓类型、2D/3D 滑块开关。分割、配件、纹理是业务工作区，一级入口在**右栏顶部的 tab 条**（不再占用第二行）；进入任一工作区会同步切换 2D/3D 并保持右栏工作区。

右侧分割引擎默认以结果为主，参数配置折叠；推荐打孔只会把推荐位置变成贯通孔，其余位置保留虚线提示。底部状态栏显示当前工程、存储来源、已保存数量和最近项目。

工作台布局：右栏为**全高整列**（`designer-app-frame` 内「主列 + 右栏」并行），顶部工具栏/品牌栏在右栏左侧被截断，右栏从窗口顶部一直到底部。左右栏分别有所属面板的收起按钮；拖动分隔条低于阈值会压缩为边缘标签。左/右/顶三侧收起态统一为「透明玻璃细带 + 悬停玻璃滑出」：鼠标靠近边缘即滑出玻璃面板（左/右栏为竖条 rail，整条可点击展开；顶栏为横向条带，点击任意位置展开，面板内含「展开工具 / 状态 / 保存 / 3MF」，支持键盘 Enter/空格）。选择分割、配件或纹理工作区会自动展开右栏并收起左栏（绘图任务完成后左栏不再需要）。2D/3D 滑块开关位于轮廓类型卡右侧、与轮廓卡同尺寸：点击滑块在 2D（左）与 3D（右）间滑动切换，只改变中央视图，不关闭当前右侧工作区。分割结果区同样吸顶：标题/板数/摘要/警告常驻玻璃层，板块列表在下方独立滚动。

启用自定义图片纹理后，3D 板面左上角会显示“图片定位”浮层：拖动板面改变图片位置，滚轮缩放，右栏可精确修改比例、旋转和偏移。

常用快捷键：

| 快捷键 | 功能 |
|---|---|
| `V` | 选择 |
| `P` | 直线 |
| `R` | 矩形 |
| `C` | 圆 |
| `A` | 弧 |
| `G` | 多边形 |
| `S` | 槽口 |
| `O` | 等距实体 |
| `E` | 擦除 |
| `D` | 智能尺寸 |
| `Ctrl/Cmd + S` | 保存 |
| `Ctrl/Cmd + O` | 打开 |
| `Ctrl/Cmd + Z/Y` | 撤销/重做 |

## 14. 验证与故障排查

每次代码改动至少执行：

```bash
npm run build
npm run lint
```

几何或导出改动还应执行 `.tmp-3d-test/` 中的对应脚本，尤其是：

- `verify-manufacturing-export.mjs`：多盘、斜放、禁放区、实例复用和 Bambu 盘号；
- `verify-interactive-holes.mjs`：候选孔与贯通孔语义；
- `verify-hybrid-cutouts.mjs`：内孔与板件布尔；
- `verify-project-file.cjs`：项目文件解析、非法 schema 和恢复。
- `verify-lumina-performance.mjs`：四块大板生成耗时、主线程心跳、分阶段进度和取消；
- `verify-lumina-mask-export.mjs`：PETG LUT 加载、顶部模具和光学层闭合网格；
- `verify-texture-direct-manipulation.mjs`：板面拖图与滚轮缩放；
- `verify-consumer-layout.mjs`：文件区、返回2D、侧栏折叠和悬停展开。
- `scripts/verify-textured-3mf.mjs <file.3mf>`：全局基材参数、表层 part 覆盖、父对象 components、细磨砂 Z 翻转和 Lumina/质感贴面两种层级；
- `npm run verify:parts`：8 类词表、双布局扫描、Portal、退出接口和旧锚点状态；
- `npm run verify:assembly`：长孔轴向、90° 拒绝、全局占孔、contactZ、旧锚点探测和候选孔开孔；
- `verify-hole-open-store.mjs`：自动开孔幂等性、无 sources 旧结果兼容和手动切换。

常见问题：

- 打开列表为空：只导出 3MF 不等于保存可编辑项目；重新点击保存或重新排盘，当前实现会同步保存 `.snapboard` 快照；
- 自选目录显示“需要重新授权”：重新点击“保存位置”，这是浏览器目录权限生命周期，不代表文件丢失；
- Bambu Studio 打不开旧 3MF：旧文件可能使用修复前的 0-based `plater_id`，重新导出；
- 旧 3MF 仍显示整块 0.08 mm/100% 填充：旧文件不会被网页修改，重新导出后才会写入基材全局参数和表层 part 覆盖；
- 切片器中只想整体移动复合板：请选择尺寸为“复合板件（整体移动）”的父对象，不要只点子零件；子零件仍可单独修改耗材槽和对象参数；
- 配件不进入 3MF：检查 `part.json` 是否提供 `model.print` 和合法制造网格；
- 构建时报大 chunk：当前是 Three.js/几何依赖的体积提示，不是构建失败。

## 15. 后续工作边界

短期优先级：云端项目 API、项目版本冲突提示、项目缩略图、导出前模型预览和更明确的错误日志。中期再考虑 STEP/SLDPRT 的浏览器几何转换、资源包签名、收藏搜索和大模型分块加载。

不应在没有明确产品决策前加入：静默写入任意电脑路径、把预览虚线导出成实体、用薄盖模拟打孔、让 3MF 文件承载不可验证的切片器配置，或用普通 JSON 绕过 `.snapboard` schema 校验。
