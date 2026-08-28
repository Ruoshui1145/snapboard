# SnapBoard 2.0 项目交接说明

更新时间：2026-08-28  
当前应用本体：`D:\自动切片设计软件\snapboard-v2\`

SnapBoard 是面向 3D 打印洞洞板的浏览器设计、自动分割、3D 装配和制造导出工具。当前 Studio 应用位于 `snapboard-v2/`，官网/Wiki 位于 `apps/wiki/`；历史原型和外围工具已归档到 `_archive/legacy/`，不属于运行时主链路。

## 文档入口

GitHub 新仓库设置与发布流程：[`docs-internal/GITHUB_SETUP.md`](docs-internal/GITHUB_SETUP.md)

详细实现、数据流、存储、3MF 兼容、排障和路线请先读：

[`snapboard-v2/docs/PROJECT_DOCUMENTATION.md`](snapboard-v2/docs/PROJECT_DOCUMENTATION.md)

专题文档：

- [`snapboard-v2/docs/TECH_SPEC.md`](snapboard-v2/docs/TECH_SPEC.md)：技术栈和模块边界；
- [`snapboard-v2/docs/PROJECT_FILE_FORMAT.md`](snapboard-v2/docs/PROJECT_FILE_FORMAT.md)：`.snapboard`、制造清单、3MF 和保存 API；
- [`snapboard-v2/docs/PART_LIBRARY_ASSEMBLY_ROADMAP.md`](snapboard-v2/docs/PART_LIBRARY_ASSEMBLY_ROADMAP.md)：配件包和装配路线。

商业运营、定价、校园社区、打印履约以及科创/商业路线决策资料在本地 `商业运营/`，该目录不进入公开 GitHub 仓库；工程图和孔位来源在 `assets/drawings/`，不要把商业资料当成运行时代码。公开文档、开发日志和部署说明由 `apps/wiki/` 管理。路线决策入口是 [`商业运营/08-科创主线与商业验证决策指南.md`](商业运营/08-科创主线与商业验证决策指南.md)。

## 当前产品链路

```text
2D 草图/尺寸约束
        ↓
正交轮廓自动分割、孔位和边缘融合
        ↓
Three.js 3D 板件/配件装配预览
        ↓
.snapboard 可编辑项目 + 多盘 3MF 制造文件
```

当前实现包括：

- 直线、矩形、圆、弧、槽口、多边形、等距、擦除和智能尺寸；
- Planegcs WASM 约束求解和 Zustand Command 撤销/重做；
- 正交外轮廓、内孔、跨板孔、边缘融合、热床旋转和制造警告；
- 2D/3D 统一孔位状态：候选孔显示虚线，`knocked=true` 才是贯通孔；
- Three.js 实体板厚、孔、倒角、配件拖放、锚点吸附和选择高亮；
- 资源包扫描、3MF/STL/GLB/GLTF 预览、参数配件和制造模型导出；
- `.snapboard` 项目保存、默认本地项目库、用户自选文件夹和项目列表；
- 多对象、多盘 3MF，导出前进行闭合网格和 Bambu 实例映射校验。

## 目录结构

```text
D:\自动切片设计软件\
├── README.md                         # 本项目索引
├── PROJECT_STRUCTURE.md              # 模块化结构和迁移规则
├── start-wiki.bat                    # Wiki 一键启动
├── apps/wiki/                        # ★ 官网、Wiki 与开发日志
├── modules/                          # 领域模块边界说明
├── assets/drawings/                  # DXF/SVG 权威规格
├── 商业运营/                          # 内部产品和运营资料
├── vendor/lumina-studio/             # Lumina 源码与运行模板参考
├── docs-internal/architecture/       # 历史/内部架构资料
├── snapboard-v2/                     # ★ 当前 Studio 应用本体（迁移期保留路径）
│   ├── src/App.tsx                   # 路由壳
│   ├── src/components/designer/      # 设计器三栏布局
│   ├── src/components/toolbar/      # 工具、文件、分割、视图
│   ├── src/components/viewport/     # 2D/3D 视口
│   ├── src/store/useAppStore.ts     # 唯一运行时工作区
│   ├── src/types/geometry.ts        # 权威几何与工程类型
│   ├── src/utils/pegboardSplit.ts   # 自动分割和孔位
│   ├── src/utils/boardMesh.ts       # Three.js 板件网格
│   ├── src/utils/export3mf.ts       # 排盘、3MF 和网格校验
│   ├── src/utils/projectFile.ts     # 项目文件、目录授权和 API
│   ├── 配件资源包/                    # 资源包源目录
│   ├── public/partLibrary/           # 同步后的网页索引
│   ├── 已保存项目/                    # 本地开发默认项目库
│   ├── docs/                         # 当前项目详细文档
│   └── .tmp-3d-test/                 # 几何/导出回归脚本
└── _archive/legacy/                  # 历史 Python/Sketch/外围工具和旧快照
```

## 技术栈

| 层 | 实现 |
|---|---|
| 前端/构建 | React 19、TypeScript 6、Vite 8 |
| 2D/约束 | Canvas 2D、Planegcs WASM、polygon-clipping |
| 3D | Three.js r185、WebGL、OrbitControls、Raycaster |
| 状态 | Zustand 5 + Command undo/redo |
| 3MF | fflate + 自研 3MF Core/OPC 写出 |
| 本地保存 | File System Access API + IndexedDB |
| 开发期接口 | Vite middleware；生产云端接口尚未随仓库部署 |

## 启动与验证

```bash
cd snapboard-v2
npm install
npm run dev       # http://localhost:5173
npm run build
npm run lint
node .tmp-3d-test/verify-manufacturing-export.mjs
```

从根目录也可以统一运行：

```bash
npm install
npm run dev          # Studio
npm run build        # Studio 生产构建
npm run wiki:dev     # Wiki 本地预览
npm run wiki:build   # Wiki 静态构建
npm run build:all    # Studio + Wiki
npm run site:build   # 统一公开站点：/ + /community + /docs + /devlog + /design/
```

GitHub Actions 也使用 `npm run site:build`，会把 Studio 构建到 `/design/`，再和官网、文档、开发日志合并为一个 Pages 产物。

统一公开站点的路径：

- `/`：消费端官网首页；
- `/community`：校园方案与母版展示；
- `/docs`：用户、开发者和制造文档；
- `/devlog`：带截图的开发日志；
- `/design/`：在线设计器。

Vite 的 `server.watch.ignored` 不能删除，否则 Windows 编辑器临时目录可能触发 EBUSY 并导致开发服务器退出。

## 文件与保存规则

- `.snapboard`：完整可编辑工作区，不保存撤销栈、相机和临时渲染对象；
- 默认开发库：`snapboard-v2/已保存项目/`；
- “保存位置”：授权任意本地目录，项目写入目录根，3MF 写入 `制造导出/`；句柄保存在 IndexedDB；
- 排盘 3MF：同步生成项目快照；
- “另存为”：使用系统文件选择器选择当前项目文件的位置；
- 云端部署设置 `VITE_PROJECT_STORAGE_API_BASE`，实现同样的 `save/list/open/export` 接口即可接入服务器。

浏览器不允许网页静默读取用户磁盘绝对路径，首次选择目录必须由用户主动授权。界面显示目录名和文件名是浏览器安全限制下的正确行为，不应伪造绝对路径。

## 几何和制造事实

- 所有制造尺寸使用毫米；
- 长圆孔默认 5×15 mm，全局错列晶格；
- 边缘候选圆孔默认 φ6；
- 未确认候选孔只有 2D/3D 虚线，不生成薄盖、凹槽或浮动圆片；
- `knocked=true` 才生成贯通实体孔；
- 制造网格使用 48 段曲线和约 0.35 mm 倒角；
- 每条无向边必须恰好被两个三角形使用，否则阻止 3MF 导出；
- Bambu `plater_id` 必须为从 1 开始的连续盘号，旧版 0-based 文件需要重新导出。

## 重要维护边界

不要把以下历史描述写回当前文档或代码：

- “敲落孔由薄皮和可敲圆片组成”；当前是完整板面/真实贯通孔二态；
- “3MF 一定下载到系统 Downloads”；现在默认项目库、自选目录和云端基址均可用；
- “当前没有任何本地项目 API”；开发期 Vite 已提供受限文件 API；
- “所有配件都能制造导出”；没有 `model.print` 的零件只能预览；
- 指数级 L 型 DFS、旧版 22.26 错位和每块板四角敲孔等旧方案。

后续优先级是云端项目服务、版本冲突和权限、项目缩略图/BOM、资源包校验与迁移、STEP/OpenCascade WASM；详见应用目录下的详细项目文档。
