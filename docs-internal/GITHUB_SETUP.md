# GitHub 仓库设置建议

## 截图中的当前状态

| 项目 | 当前选择 | 建议 |
|---|---|---|
| Owner | `Ruoshui1145` | 保持 |
| Repository name | `SnapBoard` 可用 | 可保持；如果想统一 URL，推荐 `snapboard` 小写 |
| Description | 空白 | 填写项目简介 |
| Visibility | Public | 保持 Public，便于官网、开源软件和 EdgeOne Pages/GitHub Pages |
| Add README | On | **改为 Off**，本地已有完整 README |
| Add .gitignore | No .gitignore | **保持 No**，使用本地已经整理好的版本 |
| Add license | No license | **建议 Apache-2.0 或 MIT**，不要留空 |

## 推荐描述

```text
SnapBoard - an open-source browser-to-print system for custom modular pegboards, with 2D sketching, automatic splitting, 3D assembly, textures and multi-plate 3MF export.
```

## License 选择

推荐先选 `Apache License 2.0`：它允许社区修改、分发和商业使用，并提供更明确的专利授权条款。如果希望许可证文字更短、更容易被个人创作者理解，可以选择 `MIT License`。

注意：根目录许可证只覆盖 SnapBoard 自有代码，不自动覆盖：

- `vendor/lumina-studio/source/` 中的 Lumina 上游代码；
- 配件资源包里的第三方模型；
- 用户上传的图片、纹理和模型；
- 具有独立许可证的字体、图标和示例资产。

这些内容必须在对应目录保留原许可证，并在后续添加 `THIRD_PARTY_NOTICES.md`。

## 创建仓库后的 Git 操作

创建空仓库后，在项目根目录执行：

```powershell
git add .
git commit -m "chore: initialize SnapBoard workspace"
git remote add origin https://github.com/Ruoshui1145/SnapBoard.git
git push -u origin main
```

如果仓库名使用小写，则将 URL 中的 `SnapBoard` 改为 `snapboard`。

## GitHub Pages

推送后：

1. 打开仓库 `Settings → Pages`；
2. `Build and deployment → Source` 选择 `GitHub Actions`；
3. 工作流 `.github/workflows/wiki-pages.yml` 会构建不含设计器的 `snapboard-v2` 官网；
4. 页面地址通常为 `https://ruoshui1145.github.io/SnapBoard/`；
5. 如果绑定自定义域名，再把 `SITE_URL`、`BASE_URL` 和 CNAME 一起调整。

## 仓库中不应提交的内容

- `node_modules/`、`dist/`、`apps/wiki/build/`；
- `tmp/`、`output/`、本地项目和浏览器缓存；
- Lumina Windows 桌面运行包和大型预览输出；
- 未获许可的配件模型、用户照片和个人联系方式；
- 基金申请中的私人信息和未公开预算。

当前根 `.gitignore` 已覆盖这些大部分路径。公开前应再执行一次 `git status --short` 检查。

特别注意：`商业运营/` 已被整体忽略，市场报告、基金申请、预算和私人联系方式不会进入公开仓库。若未来需要公开其中一部分，应复制经过脱敏的版本到 `apps/wiki/docs/`，不要取消整个目录的忽略。

## GitHub 仓库功能建议

- GitHub Wiki：关闭，避免与官网“项目资料”页和 `apps/wiki` 源文件形成三套文档；
- Issues：开启，用于公开 Bug 和功能建议；
- Discussions：达到首批用户后再开启；
- Actions：保持最小权限，Pages 工作流只需要 contents read、pages write、id-token write；
- Release：推送 `vX.Y.Z` 标签会触发 `.github/workflows/release.yml`，先运行构建和分割/孔位/装配/3MF 回归，再生成公开测试预览 Release 并附带 `snapboard-v2/dist` 网站压缩包；Release 分类配置在 `.github/release.yml`。
- Security：开启 Dependabot，后续再加入 CodeQL；
- Topics：`3d-printing`、`pegboard`、`3mf`、`bambu`、`petg`、`webgl`、`react`、`vite`。

## EdgeOne Pages 双网页部署

腾讯 EdgeOne Pages 当前控制台逐步使用 EdgeOne Makers 品牌。官方资料：[`edgeone.json` 配置](https://pages.edgeone.ai/zh/document/edgeone-json)、[`构建指南`](https://pages.edgeone.ai/zh/document/build-guide)、[`EdgeOne CLI`](https://pages.edgeone.ai/zh/document/edgeone-cli)。它支持从 GitHub/Gitee/Coding 导入 Vite 项目，并可通过 `edgeone.json` 指定构建命令、输出目录和 Node 版本。仓库根目录的 `edgeone.json` 对应官网项目：构建命令为 `npm run site:build:public`，输出目录为 `snapboard-v2/dist`。另建一个 EdgeOne Pages 项目，将 Root Directory 设置为 `snapboard-v2`，它会读取子目录 `edgeone.json` 并执行 `npm run build:designer`，只发布设计器。

官网项目设置 `VITE_DESIGNER_URL` 为设计器地址；设计器项目设置 `VITE_WEBSITE_URL` 为官网地址。两边都连接同一个 GitHub 仓库即可，官网按钮会在新标签页打开设计器，不需要把设计器打进官网首屏。

两份 `edgeone.json` 的 `outputDirectory` 都是相对于各自项目根目录解析；官网使用仓库根目录，设计器使用 `snapboard-v2` 子目录，不能互换。变量修改后必须重新构建，`VITE_*` 只放公开 URL，Token 必须放在 EdgeOne/GitHub Secret。

如需在 CI 中手动上传构建产物，EdgeOne CLI 当前推荐 `edgeone makers deploy`：

```powershell
npx edgeone makers deploy .\snapboard-v2\dist -n <项目名> -e preview -t $env:EDGEONE_API_TOKEN
```

API Token 应设置过期时间并只通过环境变量或 CI Secret 注入，切勿提交到仓库。

注意：当前设计器的配件导入、默认项目库和标定写回依赖本地 Vite middleware。把设计器静态发布到 EdgeOne 后，浏览器本地文件选择/下载仍可用，但 `/api/part-library/*` 与 `/api/project-library/*` 需要另行部署后端；在后端完成前，建议把设计器网页作为演示/本地数据验证入口。EdgeOne 的自定义域名与备案要求以[官方域名文档](https://pages.edgeone.ai/zh/document/custom-domain)和控制台提示为准。
