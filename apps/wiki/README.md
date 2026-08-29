# Public documentation source

这里保存 SnapBoard 对外公开的 Markdown 文档、模块说明和开发日志。面向普通用户的官网由 `snapboard-v2` 提供（本地 `http://127.0.0.1:5173/`），设计器可作为第二个独立网页部署；本目录不再作为第二个官网运行。

如需维护文档源或检查 Markdown 结构，仍可以使用 Docusaurus 本地构建：

## Installation

```bash
npm install
```

**Note**: feel free to use the package manager of your choice.

## 文档源预览

```bash
npm run start
```

此命令只用于贡献者预览文档源，不是用户启动 SnapBoard 官网的方式。普通用户请在仓库根目录运行 `npm run dev`，或双击 `start-wiki.bat`。

## Build

```bash
npm run build
```

This command generates a documentation-only static preview into the `build` directory. EdgeOne Pages publishes the marketing site and the designer as two separate projects: the root project uses `npm run site:build:public`, while the `snapboard-v2` project uses `npm run build:designer`.

## Deployment

公开官网与设计器目前使用 EdgeOne Pages / EdgeOne Makers 的两个项目部署，不在此目录执行 `gh-pages` 推送。项目配置和上线步骤见 [`snapboard-v2/docs/DEVELOPMENT_GUIDE.md`](../../snapboard-v2/docs/DEVELOPMENT_GUIDE.md) 与 [`docs-internal/GITHUB_SETUP.md`](../../docs-internal/GITHUB_SETUP.md)。

如需单独预览文档源，仍可以使用：

```bash
npm run build
```

该命令只生成文档源静态预览，不是官网生产产物。

历史上的 GitHub Pages 部署命令仅保留作迁移参考：

```bash
USE_SSH=true npm run deploy
```

不建议新项目继续使用该路径；EdgeOne 项目应从 Git 仓库导入并读取仓库根目录或 `snapboard-v2/` 下的 `edgeone.json`。
