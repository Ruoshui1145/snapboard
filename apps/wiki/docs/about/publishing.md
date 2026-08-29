---
title: GitHub 与网站发布
---

# GitHub 与发布

当前公开仓库为 <https://github.com/Ruoshui1145/snapboard>。普通用户通过官网的“项目资料”页进入产品、文档和开发日志；设计器作为第二个网页独立部署。本目录是公开资料的维护源，不再单独发布一个 Wiki 首页。

商业运营资料、基金预算和个人信息不在公开仓库中。

新建仓库的推荐选项、许可证边界和首推命令见根目录 `docs-internal/GITHUB_SETUP.md`。

## 发布步骤

1. 在 GitHub 创建 `SnapBoard` 仓库；
2. 将本地仓库添加 remote；
3. 确认公开内容不包含个人信息、内部预算和未授权模型；
4. 在 GitHub Pages 中选择 GitHub Actions；
5. 推送 `main` 分支，工作流构建 `snapboard-v2` 的官网模式；
6. 官网的“项目资料”页链接到本目录中的公开文档和开发日志，设计器使用独立部署地址，GitHub 仓库仍作为源码与完整记录入口。

## 本地构建

```powershell
npm install
npm run site:build:public
```

本地使用 `site:build:public` 构建不含设计器的官网；使用 `npm --workspace snapboard-v2 run build:designer` 构建独立设计器。官网部署产物为 `snapboard-v2/dist`，最终路径为：官网 `/`、校园方案 `/community`、使用指南 `/guide`、项目资料 `/project`、打印服务 `/print`；设计器使用另一个部署地址。`apps/wiki` 仍可单独执行 `wiki:build` 检查文档源，但不再需要单独启动 3000 端口。

设计器目前包含本地 Vite middleware 用于配件导入、标定写回和默认项目库；若将其作为纯静态网页部署，需在后续接入独立后端后才能开放这些服务器端能力。

## 自定义域名

后续可将官网绑定到根域名，设计器绑定到 `app.<你的域名>` 或 `designer.<你的域名>`。不要在获得域名之前把示例地址写进正式材料；绑定后同步更新官网的 `VITE_DESIGNER_URL` 和设计器的 `VITE_WEBSITE_URL`。
