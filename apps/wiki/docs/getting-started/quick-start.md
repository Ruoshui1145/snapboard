---
title: 快速启动
---

# 本地启动

## 环境

- Windows 10/11；
- Node.js 20 或更高；
- npm；
- Chrome 或 Edge。

## 启动 Studio

```powershell
cd snapboard-v2
npm install
npm run dev
```

访问 `http://127.0.0.1:5173/design`。

也可以双击项目根目录的 `start-dev.bat` 或 `snapboard-v2/一键启动 SnapBoard.bat`。

## 启动 Wiki

```powershell
npm install
npm run wiki:dev
```

## 构建全部项目

```powershell
npm run build:all
```

## 常用验证

```powershell
cd snapboard-v2
npm run verify:split
npm run verify:holes
npm run verify:assembly
npm run verify:3mf
npm run verify:textured-3mf
```

