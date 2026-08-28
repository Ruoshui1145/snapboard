---
title: 架构概览
---

# 架构概览

SnapBoard 采用过渡式 monorepo：`apps/` 放可部署应用，`modules/` 定义领域边界，当前 Studio 在完成拆包前仍保留 `snapboard-v2/` 路径。

```text
Sketch → Split → Manufacturing
   │        │          ↑
   └→ Assembly ← Parts┘
         ↑
      Texture
```

应用壳只负责路由、布局和组合；算法、制造和资源格式逐步形成独立公共 API。

