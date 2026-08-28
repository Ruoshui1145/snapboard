# SnapBoard 项目结构与迁移规则

## 目标结构

SnapBoard 采用“应用、领域模块、文档运营、第三方参考、归档”五层结构。当前采用过渡式迁移，正式应用 `snapboard-v2/` 暂不移动，避免一次性修改大量导入路径。

```text
SnapBoard/
├── apps/
│   └── wiki/                      # Docusaurus 官网/Wiki/开发日志
├── snapboard-v2/                  # 当前 Studio 应用（迁移期保持路径）
├── modules/                       # 领域模块边界和迁移说明
│   ├── sketch-engine/
│   ├── split-engine/
│   ├── assembly-engine/
│   ├── texture-engine/
│   ├── manufacturing-engine/
│   └── part-platform/
├── 商业运营/                       # 内部运营、调研、基金与试点资料
├── vendor/                        # Lumina 等第三方开源参考/运行模板
├── assets/                        # DXF/SVG、品牌和文档图片
├── docs-internal/                 # 内部架构、决策和迁移记录
├── _archive/legacy/               # 历史原型与外围实验
├── output/                        # 生成产物，不作为源码
├── workspace-data/                # 本地测试项目与用户数据，不作为源码
└── tmp/                           # 临时文件，不作为源码
```

## 应用与模块边界

| 边界 | 负责内容 | 当前实现位置 |
|---|---|---|
| Studio 应用壳 | 路由、布局、全局状态、工作区组合 | `snapboard-v2/src/App.tsx`、`components/designer`、`store` |
| Sketch Engine | 2D 图元、约束、智能尺寸、修剪、吸附 | `src/engine`、`commands/SketchCommands.ts`、`hooks/useSketchTool.ts` |
| Split Engine | 正交分割、融合、孔阵、热床、Worker | `src/utils/pegboardSplit.ts`、`holePattern.ts`、`workers` |
| Assembly Engine | 3D 视口、板件网格、相机、配件吸附 | `components/viewport/Viewport3D.tsx`、`utils/assembly*`、`boardMesh.ts` |
| Texture Engine | Lumina LUT、图片映射、表层/基层 | `components/texture`、`utils/boardTexture.ts`、`luminaLut.ts` |
| Manufacturing Engine | 3MF、多盘、打印机预设、验证 | `utils/export3mf.ts`、`bambuPrinterPresets.ts`、`scripts/verify-*` |
| Part Platform | 配件资源包、导入、缩略图、锚点标定 | `partLibrary`、`components/partLibrary`、`scripts/sync-part-library.mjs` |

## 依赖方向

```text
Sketch Engine ──→ Split Engine ──→ Manufacturing Engine
      │                  │                    ↑
      └──→ Assembly Engine ←── Part Platform ─┘
                         ↑
                  Texture Engine

apps/studio 只负责组合模块，不承载领域算法。
apps/wiki 不依赖 Studio 运行时代码，只读取公开文档和静态媒体。
商业运营与 vendor 不得被浏览器运行时代码直接导入；运行必需模板需要复制到明确的 runtime 资源目录。
```

## 迁移原则

1. 一次只抽取一个领域模块，抽取前先确保相关 `verify:*` 脚本通过；
2. 先建立公开 API 和类型，再移动实现文件；
3. 不从一个模块深层导入另一个模块的内部文件；
4. 第三方 Lumina 源码放在 `vendor/`，SnapBoard 自己的纹理算法放在 `texture-engine`；
5. Wiki 只发布经过筛选的公开文档，市场报告、个人信息和基金内部预算默认不公开；
6. 历史原型放入 `_archive/legacy`，不得继续被正式应用导入；
7. 每次路径迁移同时更新 README、Wiki、启动脚本和验证脚本。

## 公开与内部边界

公开 GitHub 仓库和统一站点只包含：

- `snapboard-v2/` 软件本体与必要示例资源；
- `apps/wiki/` 官网、用户文档、模块架构和开发日志；
- `modules/` 模块边界说明；
- `assets/drawings/` 已确认可公开的工程输入；
- `.github/` 构建与 Pages 部署配置。

本地保留、不进入公开仓库的内容包括：

- `商业运营/` 市场报告、商业计划、基金申请、预算和执行表单；
- `workspace-data/`、`tmp/`、`output/`、本地项目和测试缓存；
- `vendor/lumina-studio/source/` 上游源码和 `runtime-reference/` 桌面包；
- 未授权配件模型、用户照片和私人联系方式。

## 分阶段迁移

### Phase A：已实施

- 创建 `apps/wiki`；
- 创建模块边界说明；
- 根目录加入 npm workspaces 统一命令；
- 建立 Wiki、开发日志和 GitHub Pages 工作流；
- 归类 Lumina、历史原型、工程图和旧架构资料。

### Phase B：下一步

- 抽取 `manufacturing-engine`，因为其验证脚本最完整；
- 抽取 `texture-engine`，隔离 Lumina 参考代码；
- 抽取 `assembly-engine` 和 `part-platform`；
- 最后抽取 Sketch/Split，避免在算法仍高频变化时制造大量路径改动。

### Phase C：稳定期

- 将 `snapboard-v2` 移为 `apps/studio`；
- 为每个 `packages/*` 建立独立 `package.json`、测试和边界 lint；
- 按需要引入 Turborepo/Nx 缓存，不在项目数量尚少时增加额外复杂度。
