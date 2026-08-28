---
title: GitHub 与网站发布
---

# GitHub 与发布

当前本地仓库还没有配置 GitHub remote，因此 Wiki 已准备 GitHub Pages 工作流，但不会假装已有公开仓库。

新建仓库的推荐选项、许可证边界和首推命令见根目录 `docs-internal/GITHUB_SETUP.md`。

## 发布步骤

1. 在 GitHub 创建 `SnapBoard` 仓库；
2. 将本地仓库添加 remote；
3. 确认公开内容不包含个人信息、内部预算和未授权模型；
4. 在 GitHub Pages 中选择 GitHub Actions；
5. 推送 `main` 分支，工作流构建 `apps/wiki`；
6. 将 `GITHUB_REPOSITORY` 自动转换为导航中的 GitHub 链接。

## 本地构建

```powershell
npm install
npm run site:build
```

`site:build` 会先以 `/design/` 为基础路径构建 Studio，再把 Studio 的静态文件放入 Wiki 的 `static/design/`，最后构建统一站点。该命令使用跨平台 Node 脚本，兼容 Windows 和 GitHub Actions 的 Ubuntu runner。最终路径为：官网 `/`、文档 `/docs`、开发日志 `/devlog`、设计器 `/design/`。

## 自定义域名

后续可将文档站绑定到 `wiki.<你的域名>`，Studio 使用 `app.<你的域名>`，官网使用根域名。不要在获得域名之前把示例地址写进正式材料。
