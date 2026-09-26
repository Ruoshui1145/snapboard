# SnapBoard 文档地图：两个入口，其他都是证据库

Windows 桌面发行：[安装包构建与用户数据目录](desktop/README.md) · [整体 Debug 与封装记录](snapboard-v2/docs/DESKTOP_PACKAGING_DEBUG.md)。

2026-09-05 资料整理：[完整交付文件夹](release/SnapBoard-beta.2-完整交付/) · [商业运营入口](商业运营/README.md) · [统一共享素材库](商业运营/共享素材库/README.md)。

SnapBoard 的文档分为两种用途，不要求每位读者从头阅读整个仓库。

## A. 拓竹申请材料

当前唯一入口：[Let's Make It 申请目录](商业运营/拓竹LetsMakeIt申请/README.md)。本次按真实表单重编，旧申请文案与简略提案已由新版本替代。**2026-09-25 已把历史稿整体归档到 `_archive/拓竹申请-历史稿-20260925/`（204 个文件 / 479 MB，内部路径保持不变）；下面的链接只指向当前在用文件。**

1. [提交前复核与更新清单](商业运营/拓竹LetsMakeIt申请/09-提交前复核与更新清单-20260925.md)：先读。核对项、口径演变、预算与工期定稿、待申请人确认清单。
2. [中文表单填写稿](商业运营/拓竹LetsMakeIt申请/08-中文表单与素材清点/02-LetsMakeIt中文表单填写稿.md)：六个输入框的纯正文（项目描述两版二选一），每栏不超过 5,000 字，不使用 Markdown。
3. [中文素材选用与附件顺序](商业运营/拓竹LetsMakeIt申请/08-中文表单与素材清点/03-中文素材选用与附件顺序.md)：主提案与可选图片、格式数量与大小校验。
4. [表单稿自检脚本](商业运营/拓竹LetsMakeIt申请/08-中文表单与素材清点/校验表单稿.mjs)：只读校验逐块字数、Markdown 残留、禁用口径词，并按区间求和核对预算。
5. [视频发布数据与拼图](商业运营/拓竹LetsMakeIt申请/10-视频发布数据-20260925/)：三平台发布四天数据、拼图成品与生成脚本。

有效研发计划、预算和独有历史开发记录位于该申请目录的 `04-制作源文件/`。申请范围是智能化家居零件制造，不限于洞洞板；长期目标涉及参数化适配、多场景装配套组与结构优化路线，按研发目标说明，不得写成已经实现，也不得写「既有方案 / 原方案」。

旧申请文案、图文评审包、素材原件库与两个提交用 ZIP 已移入 `_archive/拓竹申请-历史稿-20260925/`，要追溯旧稿去那里找，不要当提交素材。

## B. 互联网公开开发日志

公开开发只维护一个持续更新的入口：`apps/wiki/blog/` → 网站 `/devlog`。每个版本一篇短日志，使用“问题 → 判断 → 修改 → 结果 → 下一步”，配真实截图或准确技术图。

普通读者最多先看：

- [完整工作流](apps/wiki/docs/product/workflow.md)
- [自动分板与孔位](apps/wiki/docs/product/splitting-and-holes.md)
- [3D 装配](apps/wiki/docs/product/assembly.md)
- [纹理工作室](apps/wiki/docs/product/texture-studio.md)
- [3MF 制造包](apps/wiki/docs/manufacturing/3mf.md)

## C. 工程证据库（不作为默认阅读入口）

2026-09-09 产品路线更新：创意套组成为 2.0 主入口，高度自由定制保留为另一项服务。决策摘要见 [统一基线](docs-internal/PROJECT_UNIFIED_BASELINE.md) 顶部补充；完整产品与参数化适配规划位于本地 `商业运营/项目规划/09-SnapBoard2.0创意套组与参数化适配规划.md`。这是规划状态，当前产品版本仍为 1.0。

统一入口：[项目统一战线基线](docs-internal/PROJECT_UNIFIED_BASELINE.md)。它记录各条开发/宣传/申请对话的职责、当前结论、权威文件和不得对外承诺的边界；新任务应先阅读该文件。

`snapboard-v2/docs/` 中的技术规格、项目文件格式、分割研究、装配提案、力学验证、CHANGELOG 和 AI 交接提示词继续保留，用于开发、审查和复现；它们不应全部上传给申请评审或普通用户。


SnapBoard内置多色表层已统一使用SnapColor产品名；品牌替换、旧工程迁移、LUT资产路径、暂时关闭的像素/SVG入口与恢复步骤见：[SnapColor产品化封装与兼容说明](snapboard-v2/docs/SNAPCOLOR_PACKAGING.md)。

MakerWorld 打印配置上传、打印机/喷嘴/工艺兼容和 3MF 发布排障见：[MakerWorld 3MF 发布兼容性与故障排查](snapboard-v2/docs/MAKERWORLD_3MF_PUBLISHING_TROUBLESHOOTING.md)。该文档同时限定 SnapBoard 原生 3MF 与 MakerWorld 可发布打印配置之间的能力边界。


## 上传原则

- 申请材料优先展示“已经做成的闭环”和真实证据；
- 公开日志展示过程、失败和修正；
- 内部技术文档只在被询问时作为证据链接；
- 未实现的 STEP 直接导入、云端协作、完整多部件 3MF 和强度保证必须标为规划/验证中；
- 未授权模型、个人信息、预算草稿和联系方式不进入公开材料。

## D. SnapColor 独立颜色引擎（研发中）

SnapBoard当前已经使用SnapColor产品名与工程字段，但运行时仍是经过封装和兼容迁移的既有校准LUT链路；`snapcolor-engine/` 是后续替换该兼容层的独立实现，尚未接管SnapBoard生产运行时。两者不得在文档中混称为“独立引擎已完成接入”。开发者阅读顺序：

1. [开发指南](snapcolor-engine/docs/DEVELOPMENT_GUIDE.md)
2. [引擎架构](snapcolor-engine/docs/ARCHITECTURE.md)
3. [自主校色工作流](snapcolor-engine/docs/CALIBRATION_WORKFLOW.md)
4. [与SnapBoard的整合契约](snapcolor-engine/docs/INTEGRATION_CONTRACT.md)
5. [独立实现记录](snapcolor-engine/docs/INDEPENDENCE_LOG.md)
6. [工艺产品路线](snapcolor-engine/docs/PROCESS_PRODUCT_ROADMAP.md)

当前图形化测试台运行于 `http://127.0.0.1:24681/`。所有模拟profile只能用于软件流程验证，不能作为PETG颜色精度或正式制造性能证明。

## E. 视频与 Remotion

- [A01/A02 Remotion 工程入口](snapboard-video/README.md)；
- [A01 V3 素材替换端口](snapboard-video/specs/A01-V3/ASSET_MANIFEST.md)；
- [A01 V3 审核报告](snapboard-video/specs/A01-V3/REVIEW_REPORT.md)；
- [A01/A02 V3 开发记录](商业运营/视频宣发中心/01-第一期重点主片/06-最终版汇总/04-审核与技术记录/A01-A02-V3-Remotion开发记录.md)；
- [第一期主片最终与候选文件清单](商业运营/视频宣发中心/01-第一期重点主片/06-最终版汇总/FINAL_MANIFEST.md)。

当前边界：A01 V3 已渲染，A01 V4 仅规划；A02 长孔版已渲染；正式发布仍需同一工程素材、最终口播和声音审核。

## beta.2 补充索引

- [独立配件资源包与智能尺寸输入修复](snapboard-v2/docs/RESOURCE_PACK_AND_DIMENSION_FIX.md)：安装/资源分离、导入方式、安全校验和桌面/界面回归结果。
