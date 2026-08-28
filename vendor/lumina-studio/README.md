# Lumina Studio 第三方边界

SnapBoard 参考并集成 Lumina Studio 的开源叠色思路，但第三方源码、桌面运行包与 SnapBoard 自己的 Texture Engine 必须分开维护。

| 目录 | 用途 | 主仓库策略 |
|---|---|---|
| `source/` | Lumina 原始开源仓库，保留其独立 `.git` | 不直接提交到 SnapBoard 主仓库；未来改为 submodule |
| `runtime-reference/` | Windows 预览程序、LUT、示例和输出 | 本地参考，不随官网/主源码发布 |
| `runtime-template/` | SnapBoard 构建真正需要的最小模板 | 可以提交；当前包含 Bambu 配置模板 |

SnapBoard 自有代码位于：

- `snapboard-v2/src/components/texture/`
- `snapboard-v2/src/utils/boardTexture.ts`
- `snapboard-v2/src/utils/luminaLut.ts`
- `snapboard-v2/src/utils/panelBoolean.ts`

升级 Lumina 时，先在 `source/` 核对上游许可证和变更，再把确实需要的最小运行数据同步到 `runtime-template/`，不得让正式构建依赖整个 Windows 运行包。

