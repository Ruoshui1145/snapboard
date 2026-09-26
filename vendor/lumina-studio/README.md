# Lumina Studio 第三方边界与GPLv3归属

SnapBoard 1.0 Public Beta 集成Lumina Studio的GPLv3叠色代码、LUT与Bambu配置模板，因此当前组合发行版整体采用GPL-3.0-only。第三方源码、桌面运行包与SnapBoard自己的代码仍需分目录维护，以便保留来源、许可证、修改记录和后续升级边界。

| 目录 | 用途 | 主仓库策略 |
|---|---|---|
| `source/` | Lumina 原始开源仓库，保留其独立 `.git` | 作为上游来源与版本审计依据；公开发行时不得遗漏其GPLv3归属 |
| `runtime-reference/` | Windows 预览程序、LUT、示例和输出 | 本地参考，不随官网/主源码发布 |
| `runtime-template/` | SnapBoard 构建真正需要的最小模板 | 随GPLv3组合版本发布；当前包含Bambu配置模板 |

SnapBoard 自有代码位于：

- `snapboard-v2/src/components/texture/`
- `snapboard-v2/src/utils/boardTexture.ts`
- `snapboard-v2/src/utils/luminaLut.ts`
- `snapboard-v2/src/utils/panelBoolean.ts`

升级Lumina时，先在`source/`核对上游许可证、版本和变更，再把确实需要的最小运行数据同步到`runtime-template/`，不得让正式构建依赖整个Windows运行包。同步文件必须更新根目录第三方说明、上游版本/提交、文件清单和本项目修改记录。
