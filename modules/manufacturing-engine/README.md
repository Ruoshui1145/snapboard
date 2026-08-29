# Manufacturing Engine

当前开发指南：[`docs-internal/architecture/DEVELOPMENT_GUIDE.md`](../../docs-internal/architecture/DEVELOPMENT_GUIDE.md)

## 当前职责

- 多盘排布、斜放、有效打印区域；
- 3MF Core/OPC、对象变换、材料和缩略图；
- Bambu/X2D/P2S 打印机预设；
- 板件/配件分盘和独立打印参数；
- 闭合网格、盘号和兼容性验证；
- 导出进度与降级制造包。
- 预览虚线、面板标签和配件拖拽辅助对象不会写入制造网格；
- 3MF 的 Bambu `plater_id` 使用连续 1-based 盘号，并在写出前检查对象/实例映射。

## 当前实现

`utils/export3mf.ts`、`bambuPrinterPresets.ts`、`boardMesh.ts`、`scripts/verify-*3mf*.mjs`。
