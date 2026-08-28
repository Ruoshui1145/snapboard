# Split Engine

## 当前职责

- 正交轮廓自动分割；
- 相邻小块融合和斜放热床验证；
- 全局错列长圆孔阵列与 5 mm 固定孔；
- 外轮廓圆角、拼接边和内孔避让；
- Worker 计算、缓存和性能进度。

## 当前实现

`snapboard-v2/src/utils/pegboardSplit.ts`、`holePattern.ts`、`contourMerge.ts`、`printBed.ts`、`workers/`。

## 公共输出

制造板件、孔位、拼接关系、热床摆放候选和警告，不负责渲染与 3MF 序列化。

