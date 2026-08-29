# Sketch Engine

当前开发指南：[`docs-internal/architecture/DEVELOPMENT_GUIDE.md`](../../docs-internal/architecture/DEVELOPMENT_GUIDE.md)

## 当前职责

- 直线、矩形、圆、弧、多边形、槽口和等距实体；
- Planegcs 约束、智能尺寸、原点和端点吸附；
- 修剪、擦除、拖动顶点和撤销/重做；
- 外轮廓与内轮廓的可编辑几何。

## 当前实现

`snapboard-v2/src/engine`、`commands/SketchCommands.ts`、`hooks/useSketchTool.ts`、`components/viewport/SketchViewport2D.tsx`。

## 公共输出

标准化 `SketchEntity[]`、闭合轮廓、约束状态和尺寸修改命令。不得直接生成 Three.js 网格或 3MF。
