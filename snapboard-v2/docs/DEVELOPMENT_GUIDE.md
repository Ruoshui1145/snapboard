# SnapBoard 开发与部署指南

更新时间：2026-08-29
适用版本：SnapBoard v2 / 当前 `main`

本文是新开发者、维护者和部署人员的统一入口。它描述当前真实运行方式，不把历史原型、商业运营资料或本地文件 API 当成线上能力。

> 平台说明：EdgeOne Pages 已逐步升级为 EdgeOne Makers。本文沿用“EdgeOne Pages”描述静态网页托管场景，控制台和 CLI 中可能显示为 “Makers”。

## 1. 当前架构：双网页、单仓库

SnapBoard 使用一个 GitHub 仓库维护两个可独立部署的网页：

```text
GitHub: Ruoshui1145/snapboard
       │
       ├─ 根目录官网
       │    npm run site:build:public
       │    输出：snapboard-v2/dist
       │    内容：首页 / 社区 / 指南 / 项目资料 / 打印服务
       │
       └─ snapboard-v2 独立设计器
            npm run build:designer
            输出：snapboard-v2/dist
            内容：二维草图、分割、3D 装配、纹理和 3MF 导出
```

本地开发时两者仍可由同一个 Vite 服务调试：

- `http://127.0.0.1:5173/`：官网页面；
- `http://127.0.0.1:5173/design`：设计器页面；
- 官网的“开始设计”按钮使用新标签页打开设计器地址。

生产环境中，官网和设计器使用两个 EdgeOne Pages 项目。`apps/wiki/` 只保存公开 Markdown 文档和开发日志源文件，不再启动第二个面向用户的 Wiki 首页。

## 2. 本地开发

在仓库根目录执行：

```powershell
npm install
npm run dev
```

Windows 用户也可以双击根目录的 `start-wiki.bat`；这个兼容名称现在启动的是 5173 官网/设计器开发服务，不是 3000 端口的第二个网站。

首次启动和构建会同步配件资源包。设计器开发期 API 由 `snapboard-v2/vite.config.ts` 提供，包括配件导入、标定、文件夹管理、本地项目库和系统关闭。

## 3. 构建命令

| 命令 | 用途 | 是否包含设计器 |
|---|---|---:|
| `npm run dev` | 本地开发官网和设计器 | 是（按 `/design` 路由加载） |
| `npm run build` | Studio 完整构建 | 是 |
| `npm run site:build` | 本地整合构建，便于联调 | 是 |
| `npm run site:build:public` | 官网发布构建 | 否 |
| `npm --workspace snapboard-v2 run build:designer` | 独立设计器发布构建 | 是 |
| `npm run wiki:build` | 检查公开文档源 | 不适用 |
| `npm run lint` | TypeScript/React lint | 不适用 |

官网模式通过 `VITE_PUBLIC_SITE_ONLY=1` 使用轻量 `public-site/`，不会复制本地 `public/partLibrary` 模型资源，也不会产生 `DesignerApp` chunk。设计器模式通过 `VITE_DESIGNER_ONLY=1` 启动后直接进入 Studio。

## 4. EdgeOne Pages / EdgeOne Makers 部署

EdgeOne 官方支持从 Git 仓库导入项目、覆盖根目录/构建命令/输出目录，并在 `edgeone.json` 中声明 Node 版本、SPA fallback 和响应头。官方参考：

- [`edgeone.json` 配置详解](https://pages.edgeone.ai/zh/document/edgeone-json)
- [`构建流程与设置指南`](https://pages.edgeone.ai/zh/document/build-guide)
- [`EdgeOne CLI`](https://pages.edgeone.ai/zh/document/edgeone-cli)
- [`自定义域名与 CNAME`](https://pages.edgeone.ai/zh/document/custom-domain)

仓库中有两份配置：

- 根目录 [`edgeone.json`](../../edgeone.json)：官网；
- [`snapboard-v2/edgeone.json`](../edgeone.json)：独立设计器。

### 4.1 官网项目

在 EdgeOne Pages 导入 `Ruoshui1145/snapboard`：

```text
根目录：./
生产分支：main
框架预设：Other
安装命令：npm ci
构建命令：npm run site:build:public
输出目录：snapboard-v2/dist
Node.js：22.11.0
```

官网部署完成后会得到一个公开地址。然后在官网项目环境变量中设置：

```text
VITE_DESIGNER_URL=https://设计器项目地址
```

### 4.2 设计器项目

再用同一个仓库创建第二个 EdgeOne Pages 项目，将根目录设为 `snapboard-v2`：

```text
根目录：snapboard-v2
生产分支：main
安装命令：npm ci
构建命令：npm run build:designer
输出目录：dist
Node.js：22.11.0
```

在设计器项目环境变量中设置：

```text
VITE_WEBSITE_URL=https://官网项目地址
```

部署顺序建议为：先建官网 → 再建设计器 → 将设计器地址写入官网变量 → 重新部署官网。EdgeOne 的 SPA 回退使用 `/* → /index.html`，否则直接刷新 `/guide`、`/project` 等路径可能出现 404。

EdgeOne 的 `edgeone.json` 配置相对于项目根目录解析：官网项目的根目录是仓库根目录，所以输出目录写成 `snapboard-v2/dist`；设计器项目的根目录是 `snapboard-v2`，所以输出目录只写 `dist`。不要把两个项目的输出目录互换。

### 4.3 共同配置与上线验证

### 4.3.1 环境变量与安全

`VITE_DESIGNER_URL`、`VITE_WEBSITE_URL` 和 `VITE_PROJECT_STORAGE_API_BASE` 会在 Vite 构建时注入浏览器，属于公开配置，只能填写公开 URL；不要把 API Token、数据库密码或私钥写进 `VITE_*` 变量。

在 EdgeOne 控制台修改变量后必须重新部署，旧构建不会自动读取新值。建议把官网和设计器的变量分别记录在部署台账中：

| 项目 | 必需变量 | 用途 |
|---|---|---|
| 官网 | `VITE_DESIGNER_URL` | “开始设计”按钮打开独立设计器 |
| 设计器 | `VITE_WEBSITE_URL` | “返回官网”按钮回到官网 |
| 设计器（接入后端后） | `VITE_PROJECT_STORAGE_API_BASE` | 云端项目保存/列表/打开/导出 API 基址 |

### 4.3.2 自定义域名、备案与预览

在 EdgeOne 项目的“域名管理”中添加官网根域名和设计器子域名，例如 `snapboard.example.com` 与 `designer.example.com`，按控制台给出的 CNAME 值在域名服务商处添加记录。中国大陆可用区或包含中国大陆的全球可用区通常需要先完成 ICP 备案；仅面向境外的全球可用区要求不同，最终以控制台提示为准。

开发阶段优先使用预览环境或 EdgeOne 提供的预览地址，验证通过后再把自定义域名绑定到生产环境。预览地址、生产地址和绑定环境必须写入本次迭代记录，不能把临时预览 URL 固定写进源码。

### 4.3.3 可选：EdgeOne CLI 手动部署

控制台 Git 自动部署是默认路径；需要快速验证某次构建产物时可使用 CLI。先在本地完成构建，再在 PowerShell 中通过环境变量提供短期 Token：

```powershell
# 官网
npm run site:build:public
$env:EDGEONE_API_TOKEN = '<只在当前终端临时设置，不要写入文件>'
npx edgeone makers deploy .\snapboard-v2\dist -n <官网项目名> -e preview -t $env:EDGEONE_API_TOKEN

# 设计器
npm --workspace snapboard-v2 run build:designer
npx edgeone makers deploy .\snapboard-v2\dist -n <设计器项目名> -e preview -t $env:EDGEONE_API_TOKEN
```

CI/CD 中使用同一命令时，把 Token 放在 GitHub/EdgeOne 的 Secret 中，不要放在 `edgeone.json`、`.env.example` 或提交记录里。EdgeOne CLI 当前推荐 `edgeone makers` 命名空间，`edgeone pages` 仍是过渡期兼容命令。

### 4.3.4 线上能力边界

官网是纯静态站，适合宣传、社区方案、指南和开发日志。设计器静态部署后，浏览器本地文件选择器和下载仍可工作，但以下接口仍是开发期 Vite middleware：

```text
/api/part-library/*
/api/project-library/*
/api/system/shutdown
```

要让设计器在线保存项目、写回配件资源包和多人协作，需要另外部署后端，并通过 `VITE_PROJECT_STORAGE_API_BASE` 指向实现 `save/list/open/export` 的服务。后端上线前，设计器线上地址应作为演示入口，完整配件管理在本地开发服务中进行。

## 5. 模块边界

| 模块 | 维护入口 | 责任 |
|---|---|---|
| Sketch Engine | `src/hooks/useSketchTool.ts`、`src/commands/SketchCommands.ts` | 二维图元、约束、智能尺寸、修剪 |
| Split Engine | `src/utils/pegboardSplit.ts`、`src/utils/holePattern.ts`、`src/workers/` | 异形分板、孔阵、接缝、热床约束 |
| Assembly Engine | `src/components/viewport/`、`src/utils/assembly*`、`boardMesh.ts` | 3D 板件、孔、倒角、正反面装配 |
| Texture Engine | `src/components/texture/`、`boardTexture.ts`、`luminaLut.ts` | 图片、Lumina 叠色、材质表层 |
| Manufacturing Engine | `src/utils/export3mf.ts`、`bambuPrinterPresets.ts` | 多盘 3MF、材料和打印机预设 |
| Part Platform | `src/components/partLibrary/`、`src/hooks/usePartLibrary.ts`、`vite.config.ts` | 配件导入、分类、目录、排序、标定 |
| 官网壳 | `src/components/site/`、`src/App.tsx` | 宣传页、社区、指南、项目资料和跨网页跳转 |

不要从 `商业运营/`、`vendor/lumina-studio/source/` 或 `_archive/legacy/` 直接导入浏览器运行时代码。

## 6. 资源包和性能约定

配件资源包同步流程如下：

```text
配件资源包/  ──sync-part-library.mjs──>  public/partLibrary/index.json
       │
       └─ Vite watcher：只监听模型/图片资产，500 ms 防抖，统一同步队列
```

同步器自动写入的 `part.json`、`pack.json` 和目录事件不会再次触发监听回环。多个导入、标定或改名请求共享同一同步队列，避免并发写 `index.json` 导致 Vite 退出和前端 `Failed to fetch`。

配件卡片的无封面模型使用 `IntersectionObserver` 延迟生成 WebGL 缩略图，只渲染视口附近的卡片。不要恢复“打开面板时为所有模型立即创建 WebGLRenderer”的实现。

## 7. 验证清单

提交前至少运行：

```powershell
npm run lint
npm run site:build:public
npm --workspace snapboard-v2 run build:designer
npm run wiki:build
```

涉及几何、孔位、装配和 3MF 的改动，还要运行 `snapboard-v2/scripts/verify-*.mjs` 中对应脚本。线上部署前检查：

1. 官网构建日志显示 `npm run site:build:public`，不能出现 `npm run build:designer`；
2. 官网输出目录是 `snapboard-v2/dist`，设计器输出目录是 `dist`；
3. 官网项目已设置 `VITE_DESIGNER_URL`；
4. 设计器项目已设置 `VITE_WEBSITE_URL`；
5. 直接打开和刷新 `/community`、`/guide`、`/project` 均能回到 `index.html`；
6. 公开仓库不包含 `商业运营/`、个人联系方式、基金预算和未授权模型。

## 8. 常见故障

### `Missing script: build:designer`

主页项目误用了设计器命令。根目录必须使用 `npm run site:build:public`；只有 Root Directory 为 `snapboard-v2` 的设计器项目才使用 `npm run build:designer`。

### 页面显示 `保存失败：Failed to fetch`

先查看 Vite 终端是否出现大量重复的“资源包同步完成”。若有，重启开发服务并确认同步队列、资产过滤和 127.0.0.1 绑定仍在。该错误通常表示本地开发服务已退出，不是项目 JSON 本身损坏。

### 官网按钮打开空页面

检查官网项目的 `VITE_DESIGNER_URL` 是否为完整的 `https://` 地址；没有配置时按钮只会回到官网项目资料页，避免生成失效的 `/design` 链接。

### EdgeOne 刷新子路径 404

确认根目录 `edgeone.json` 中存在精确的 SPA fallback：`source: "/*"`、`destination: "/index.html"`。同时检查输出目录是否填写为 `snapboard-v2/dist`。

## 9. 提交与公开边界

公开 GitHub 仓库只提交软件本体、必要示例、模块文档、开发日志和部署配置。商业计划、市场报告、融资申请、预算、个人信息和未授权素材继续保留在本地 `商业运营/` 或忽略目录中。

资源包模型如果来自第三方，必须在 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 中记录来源、用途和许可证边界；未获得商业授权前不得把测试素材写成可商用资产。

## 10. 每次开发变更的记录要求

每次修改都要留下可复核证据，不能只写“已优化”或只提交截图。至少更新以下内容：

1. 在 [`TECHNICAL_EVOLUTION.md`](TECHNICAL_EVOLUTION.md) 记录问题、假设、方案取舍、跨模块影响和创新证据边界；
2. 在 [`CHANGELOG.md`](CHANGELOG.md) 写面向维护者可读的变更摘要；涉及用户操作时同步更新 `apps/wiki/docs/` 对应指南；
3. 保存输入轮廓/模型、关键配置、输出 JSON 或 3MF、验证命令、耗时和前后截图；
4. 几何改动必须给出分割覆盖率、局部最小宽度、孔位数量/间距、接缝和制造网格结果；3D 改动必须给出装配面、锚点、占孔和导出结果；
5. 资源包新增模型或图片必须在 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 登记来源、作者/页面、许可证状态、测试用途和下架责任人；
6. 记录回滚方式和停止条件：代码回滚到哪个提交、资源如何移除、哪些线上数据不能覆盖。

推荐使用以下条目作为提交说明或 Issue 模板：

```text
日期 / 分支 / 版本：
用户问题与验收标准：
所属模块：Sketch / Split / Assembly / Texture / Manufacturing / Part Platform / Site
输入样本与当前假设：
修改文件、数据格式和 API 影响：
采用方案与放弃方案：
验证命令、结果、耗时、截图：
已知限制、风险和回滚点：
EdgeOne 预览地址 / 部署记录：
Release 标签（如有）：
下一步与停止条件：
```

## 11. 从提交到上线的推荐顺序

```text
功能分支
  ↓ 本地 build / lint / 专项回归
合并 main
  ↓ EdgeOne 预览部署（官网 + 设计器）
真实浏览器冒烟：刷新子路径、打开设计器、导入/导出、跨网页返回
  ↓ 验收记录与文档/CHANGELOG 更新
推送 vX.Y.Z 标签
  ↓ GitHub Release 工作流：构建 + 几何/孔位/装配/3MF 回归
公开 Release；EdgeOne 生产环境继续跟随 main 的最新成功部署
```

如果 EdgeOne 预览失败，先保留失败日志和构建配置，不要直接把未验证的产物绑定到生产域名。Release 成功只代表仓库构建与回归通过，不代表云端项目 API、账号权限或打印实物已经验证。
