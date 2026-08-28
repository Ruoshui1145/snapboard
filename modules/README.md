# SnapBoard 领域模块

本目录先定义边界和公共 API，正式代码仍在 `snapboard-v2/src`。这样可以在不破坏现有应用的前提下逐步拆包。

| 模块 | 职责 |
|---|---|
| `sketch-engine` | 2D 图元、约束、尺寸和吸附 |
| `split-engine` | 分割、融合、孔位和热床 |
| `assembly-engine` | 3D 板件、相机、配件装配 |
| `texture-engine` | Lumina、贴图、彩色/材质表层 |
| `manufacturing-engine` | 3MF、排盘、打印机预设和验证 |
| `part-platform` | 配件包、模型导入、锚点和社区格式 |

