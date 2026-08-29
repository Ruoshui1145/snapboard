# Split Engine

当前开发指南：[`docs-internal/architecture/DEVELOPMENT_GUIDE.md`](../../docs-internal/architecture/DEVELOPMENT_GUIDE.md)

## 当前职责

- 正交轮廓自动分割；
- 规则矩形平衡网格、异形特征对齐和最小结构宽度校验；
- 相邻小块融合和斜放热床验证；
- 原始轮廓唯一 5×15 A/B 长孔母阵、分板裁取与 φ5 接缝圆孔；
- 基于胶囊/圆到轮廓距离的缺口与内孔自动删孔留白；
- 外轮廓圆角、拼接边和内孔避让；
- Worker 计算、缓存和性能进度。
- `syncSplitToSketch()` 只由 `affectsSketch=true` 的草图命令触发；配件装配不能启动或取消分割任务；

## 当前实现

`snapboard-v2/src/utils/pegboardSplit.ts`、`holePattern.ts`、`contourMerge.ts`、`printBed.ts`、`workers/`。

数学依据、形状回归、孔阵拓扑研究、手动搭板和六边形实验路线见
[`snapboard-v2/docs/SPLIT_ENGINE_RESEARCH.md`](../../snapboard-v2/docs/SPLIT_ENGINE_RESEARCH.md)。

## 公共输出

制造板件、孔位、拼接关系、热床摆放候选和警告，不负责渲染与 3MF 序列化。
