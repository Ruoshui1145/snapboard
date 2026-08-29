# Public documentation source

这里保存 SnapBoard 对外公开的 Markdown 文档、模块说明和开发日志。面向普通用户的唯一入口是 `snapboard-v2` 官网（本地 `http://127.0.0.1:5173/`）的“项目资料”页；本目录不再作为第二个官网运行。

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

This command generates a documentation-only static preview into the `build` directory. The public Pages workflow publishes `snapboard-v2/dist` instead, so the marketing pages, guide, project hub and designer share one entry point.

## Deployment

Using SSH:

```bash
USE_SSH=true npm run deploy
```

Not using SSH:

```bash
GIT_USER=<Your GitHub username> npm run deploy
```

If you are using GitHub Pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.
