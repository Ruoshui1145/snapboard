---
title: 架构概览
---

# 架构概览

SnapBoard 采用过渡式 monorepo：`apps/` 放可部署应用，`modules/` 定义领域边界，当前 Studio 在完成拆包前仍保留 `snapboard-v2/` 路径。

当前 Studio 是 React 19 + TypeScript + Vite 8 应用。2D 草图使用 Canvas 2D，约束使用 Planegcs WASM，分割通过 Worker 执行，3D 使用 Three.js/WebGL，3MF 在浏览器端由 `fflate` 生成。Vite middleware 只属于本地开发期文件/API 适配，不是生产后端。

```text
Sketch → Split → Manufacturing
   │        │          ↑
   └→ Assembly ← Parts┘
         ↑
      Texture
```

应用壳只负责路由、布局和组合；算法、制造和资源格式逐步形成独立公共 API。

当前权威开发指南：[`docs-internal/architecture/DEVELOPMENT_GUIDE.md`](https://github.com/Ruoshui1145/snapboard/blob/main/docs-internal/architecture/DEVELOPMENT_GUIDE.md)。
