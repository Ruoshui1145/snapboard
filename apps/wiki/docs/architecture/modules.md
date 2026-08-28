---
title: 模块边界
---

# 模块边界

| 模块 | 输入 | 输出 |
|---|---|---|
| Sketch Engine | 用户工具、尺寸、鼠标事件 | 实体、约束、闭合轮廓 |
| Split Engine | 外轮廓、内孔、热床和孔位参数 | 板件、孔位、拼接、警告 |
| Assembly Engine | 板件、配件和锚点 | 装配变换、占用和 3D 预览 |
| Texture Engine | 图片、LUT、材料和板件 | 基层/表层对象与材料映射 |
| Manufacturing Engine | 板件、配件、材料和预设 | 多盘 3MF 与制造清单 |
| Part Platform | 模型、资源包和标定 | 可装配配件定义 |

模块只能依赖公开类型和 API，不得跨目录深层导入内部实现。

