# SnapColor 本地制造缺件与作业并发故障诊断

日期：2026-09-24。检查版本：`937ac8c`（`codex/remove-lumina-snapcolor`）。依据：[制造优化实施日志](SNAPCOLOR_MANUFACTURING_OPTIMIZATION_LOG_20260924.md)第 7、11、13、14 节。本文是诊断；未修改制造代码或现有工程文件。

## 结论

**当前阻塞缺陷是本地资产读取器未把 URL 百分号编码的中文路径还原为磁盘路径。**“长亮”的 20 个已放置配件来自 5 个紧固锁扣模型；它们在 `public/partLibrary` 中都有实体文件，`model.print` 也非空。`partAssetUrl()` 将中文路径放进 URL 后，`URL.pathname` 成为 `%E...` 编码串；`installNativeRuntime()` 直接把该串拼到磁盘路径，查找失败并返回 404。

因而实施日志第 13 节推测的“需要查看 `model` 字段内容”，现在可收敛为**URL 路径解码缺失**，不应改动这五份有效的配件清单。

调用链：

```text
index.json 中的中文 model.print
  → export3mf.ts:partAssetUrl() 生成百分号编码 URL
  → three FileLoader 传入 Request
  → native-recipe-raster.mjs:installNativeRuntime() 读取 URL.pathname
  → 未解码便 join(root, 'public', pathname)
  → 文件不存在，返回 Response(404)
  → export3mf.ts 将配件加载失败降为 warning
```

`fetch for "" responded with 404` 中的空引号不是模型地址为空：three 在报错时读取 `response.url`，而这里手工创建的 `Response` 没有 URL，因此错误文本丢失了真实请求地址。

## 复现证据

1. 五个不同的 `model.print` 都指向中文名称的 `.STL`；对每条路径，直接用编码后的 `URL.pathname` 查磁盘均为 `false`，`decodeURIComponent(pathname)` 后查同一个 `public/partLibrary` 均为 `true`。
2. 直接调用当前 `installNativeRuntime()` 读取“双圆孔平链接”模型，返回 **HTTP 404**。实际 URL 包含 `%E7%B4%A7...`；解码后的磁盘文件存在。
3. 在干净的当前工作树运行 `npm run verify:native-process`，以退出码 **1** 失败；断言报错为 `5mm厚单洞小直钩2cm 导入失败：fetch for "" responded with 404`。门禁用的库中第一个配件也含中文路径，说明实施日志第 14 节“全部通过”仅能代表当时的记录，**不代表当前 HEAD**。

关键代码：[资产 URL 构造](../src/utils/export3mf.ts)、[本地资产读取器](../scripts/native-recipe-raster.mjs)、[现有集成门禁](../scripts/verify-native-process.mjs)。

## 对产物的影响

- 默认单文件导出：板件仍可生成，但 `createManufacturingObjects()` 会逐个捕获配件异常、只追加 warning。用户可收到一个文件结构合法、却缺少这 20 个配件实例的 3MF；现有提示弹窗不足以把它视为完整交付。
- 可选逐板导出：板件文件继续生成；配件专用导出没有任何有效对象时抛错，外层仅追加“配件未能生成”警告，最终 ZIP 不包含 `-配件.3mf`。
- 现有 `verify:native-process` 不能作为绿色发布门禁；必须先修复读取器，再重新运行。`verify:native-multiplate` 只查模型结构和盘号时，不能替代对 20 个配件实例的核对。

## 最小修复与验收顺序

1. 在本地资产读取器中，对 `URL.pathname` **解码一次**，然后用解码后的路径解析成绝对路径；以 `public/partLibrary` 或 `public/snapcolor/luts` 的真实根目录做包含关系校验。先校验再读文件，拒绝编码后的 `..`、分隔符及越界路径；坏编码返回明确错误。不要修改配件清单来迁就读取器。
2. 失败信息附上原始资产 URL 或相对路径。对于用户明确要求带配件的**完整单文件制造**，配件加载失败应使这次完整交付失败；若提供“只交板件”的选择，要显式标为部分产物。
3. 将 `verify:native-process` 的 Unicode STL 读取作为稳定门禁；检查实际返回的配件对象/实例数量，而不只断言 warning 为空。另测 ASCII 路径和编码越界路径。
4. 用“长亮”验证：5 个模型资源均能加载、20 个放置实例全部进入 3MF；再检查 11 块板、背面标识、ZIP CRC，并在 Bambu Studio 实际导入/切片。

## 另一个已确认的并发缺陷

`native-manufacture-api.mjs` 为每个作业调用 `installNativeRuntime()`，但接口未限制同时运行的作业。该函数直接替换**进程级** `globalThis.fetch`，并在作业结束时恢复自己启动时捕获的旧函数。用两个连续安装的读取器复现：A 先结束会使仍在运行的 B 丢失资产 shim；B 再结束又会把 A 的 shim 留在全局。测试输出为 `lostWhileBActive: true`、`leakedAfterBoth: true`。这会造成间歇性本地资产 404 或后续请求行为异常。

按当前阶段的最小方案，先让 API **同时只运行一个制造作业**，第二个提交返回明确的“已有作业运行中”；以后若确需并行多作业，再将资产读取器改为不修改进程级 `fetch` 的作业隔离实现。这个缺陷与中文路径 404 相互独立，二者都需纳入验收。

## 性能架构备注

当前“本地制造进程”代码实际通过 Vite `configureServer` 在 **dev server 的 Node 进程**中运行，未启动独立子进程。大段同步几何计算期间，同一事件循环上的状态轮询和取消请求可能延迟；逐板 ZIP 还会同时持有每板 3MF 并调用 `zipSync`。这是后续大型工程的进度与内存风险，不能由这次路径解码修复宣称解决。应另按原方案的子进程、可取消、流式单文件验收。
