# SnapBoard 2.0 交接提示词(供其他 AI 继续开发)

> 这份提示词回顾了最近一次开发会话中新增的全部功能与需求。接手时请先读完本文件,再阅读下面的关键源码;已经实现的功能**不要回退**,已知问题从"当前待办"开始。

---

## 0. 项目背景

SnapBoard 2.0 是浏览器端 3D 打印洞洞板(pegboard)设计工具,位于 `snapboard-v2/`。

- 技术栈:React 19 + TypeScript + Vite 8(Rolldown,无 esbuild)+ three.js + Zustand + 命令模式(undo/redo)。
- 核心概念:
  - 图纸 → 自动分割成多块板件(`pegboardSplit.ts`,分割结果 `SplitPanel[]`),板件**竖直挂墙**,板面 = 世界 XY 平面,厚度沿 +Z(默认 4mm,`splitCfg.thickness`)。
  - 板面孔阵(`holePattern.ts` / `crystalSlots`):全部为**竖向 5×15 胶囊长圆孔**,A 族 (10,30)+40×40、B 族 (30,10)+40×40 晶体错列;另有用户确认制造规格 φ5 圆形敲落孔(板内,`edge_holes`,`knocked=true` 才贯通;未打通时 2D/3D 只显示虚线候选)。
  - 配件库:`配件资源包/` 目录 + `scripts/sync-part-library.mjs` 同步 → `public/partLibrary/index.json`。
  - 3D 装配:`Viewport3D.tsx` 拖拽配件 → `assemblySnap.ts` 的刚体配准把零件锚点匹配到板面孔。
- 关键文件:
  - `src/utils/assemblySnap.ts` — 装配配准核心(fitPartAnchors / splitPanelTargets / anchorsForSide / contactZForSide)
  - `src/utils/slotAxisProbe.ts` — 长圆孔锚点长轴探测(新增)
  - `src/components/partLibrary/PartMountCalibrator.tsx` — 装配标定器(锚点 + 朝向 + 接触面)
  - `src/components/viewport/Viewport3D.tsx` — 3D 视口与拖放装配
  - `src/store/useAppStore.ts` — Zustand 状态(placedParts、splitResult、toggleEdgeHole)
  - `src/partLibrary/types.ts` — 数据模型(PartMountAnchor/PartMountDefinition/PlacedPart)
  - `vite.config.ts` — 开发期 API(导入/标定/改名/系统关闭)+ 配件资源包 watcher
  - `scripts/sync-part-library.mjs` — 配件资源包同步
  - `src/App.css` — 全局样式

---

## 1. 本会话新增功能(已实现,勿回退)

### 1.1 配件资源包大类目录化
- `配件资源包/` 下建立 8 个大类目录:`01-挂钩类` `02-支架托架类` `03-搁板层板类` `04-收纳容器类` `05-整理件类` `06-紧固锁扣类` `07-底座安装类` `08-线缆整理类`。
- 分类定义在 `src/partLibrary/types.ts`:`PART_CATEGORY_OPTIONS`(9 类含"自定义")与 `PART_CATEGORY_FOLDER`(分类→大类目录名映射,`custom→''`)。
- 大类目录 = 一个"自动资源包":根目录有 `pack.json`(id 形如 `snapboard.category-<slug>`),**但没有 `parts/` 子目录时仍按大类模式扫描**(这是修过的 bug:早期同步生成 pack.json 后会把大类误当成普通包,只扫 `parts/`,导致根目录散放模型被无视)。
- 散模型归一化:大类根目录下有 ≥2 个模型文件且无(有效)`part.json` 槽位时,把每个模型 `rename`/拆分到 `<文件名去扩展名>/` 子目录,各成一个零件;根目录空槽位 `part.json` 删除。
- 分类映射词表 `categoryFromDirName`(关键字→分类 id)在 `vite.config.ts` 与 `sync-part-library.mjs` 各有一份,**必须保持一致**。
- 网页端批量导入:选/拖多个模型(单个 ≤200MB,3MF/STL/GLB/独立 GLTF),弹窗内逐文件显示状态(待导入/导入中/完成/失败),选大类后按 `配件资源包/<大类目录>/<part-id>/` 归档(走 `/api/part-library/import?filename&name&category&description[&folder]`);未指定大类进"我的配件"。

### 1.2 导入/改名弹窗:限高滚动 + React Portal
- 弹窗(`.part-import-modal`):`max-height: min(88vh, calc(100vh - 48px))` + flex 列布局,头部/底部固定,中部 `.part-import-scroll` 可滚动;`.part-import-list` 文件清单自身限高 168px。
- 两个弹窗(导入、改名)均用 `createPortal(..., document.body)` 渲染——脱离 `.designer-shell` 的 `isolation:isolate`/面板 overflow 对 `position:fixed` 的干扰,保证全屏遮罩 + 视口居中,永不被面板裁剪。
- 移除入口时同步释放 geometry/material。

### 1.3 退出系统按钮
- 工具栏「📁 文件」卡新增「退出系统」按钮:确认后 `POST /api/system/shutdown`(vite.config.ts 的 `systemControlApi`),响应后 350ms `process.exit(0)` 结束 dev server。用于用户从网页侧停止/重启后端做测试。

### 1.4 findPartManifest 双布局修复(标定保存/改名)
- `vite.config.ts` 的 `findPartManifest` 不再要求路径含 `/parts/` 子目录;改为从 part.json 所在目录**向上找最近持有 pack.json 的包根**,兼容:
  - 传统布局 `配件资源包/<包>/parts/<零件>/part.json`
  - 大类根布局 `配件资源包/<大类目录>/<零件>/part.json`(散件归一化后)
- 之前大类根布局的零件标定保存/改名都报"找不到对应的 part.json",已修复。

### 1.5 长圆孔长轴定向吸附(修复 90° 对角线调换)
- 问题:零件同时有 2 个椭圆(长圆)孔 + 2 个圆孔时,纯点距配准会把零件旋转 90°,椭圆/圆孔对角线调换后仍"吸附成功"。
- 方案(即用户确认的"两点定线"):槽孔的两个半圆弧圆心连线 = 长轴。
  - `PartMountAnchor` 新增 `axis?: [number, number]`:长圆孔锚点的长轴方向(零件局部安装面内单位向量,仅 slot 锚点)。
  - `src/utils/slotAxisProbe.ts` 的 `deriveSlotAxis(model, anchor)`:沿锚点端面法向,在端面平面内环形采样边界半径(24 方向 × 0.75–14mm 步进 0.5),**边界半径最大的方向 = 长轴**;中心探针判定极性,兼容"自带安装柱(柱心命中端面)"与"板面开孔(孔心无命中)"两种建模;长宽比 <1.35 视为圆孔返回 undefined。验证:横向胶囊柱→[1,0]、竖向→[0,1]、φ6 圆柱→undefined、板面 X 向胶囊孔→[1,0]。
  - 标定器:点击长圆孔柱端面时即时探测并写入 `axis`;**旧锚点(无 axis)在打开标定器时自动补算**(模型就绪后对既有 slot 锚点循环补),无需重新点选,保存一次即可。
  - `AssemblyTarget` 新增 `axis?: [number, number]`:板面规格孔全为竖向 → `splitPanelTargets` 给 slot 目标 `axis:[0,1]`。
  - `fitPartAnchors` 新增约束:锚点长轴经 rotationZ 旋转后须与目标长轴**平行**(`|dot| ≥ 0.9`,约 25.8°);90°/270° 时 dot=0 直接拒绝该候选。`anchorsForSide` 背面翻转时 axis 的 x 取反。
  - 验证结果:A(正确布局)吸附成功 rotZ=0°;B(90° 调换布局)新逻辑拒绝、旧逻辑误接受 rotZ=-90°。

### 1.6 孔位占用冲突修复(正/背面共用孔)
- 问题:背面紧固件占了孔,正面配件仍可吸附同一孔(孔是穿板贯通孔,物理上只能装一件)。
- `fitPartAnchors` 新增 `occupiedIds?: ReadonlySet<string>`:首锚候选、次锚候选、逐锚匹配全部过滤已占用目标。
- `Viewport3D.tsx` 新增 `occupiedTargetIds(exceptPartId?)`,从 `useAppStore.getState().placedParts` 汇总所有 `placement.targetIds`;**全局占用(不分正/背面)**;拖放/悬停用全部,移动/旋转时排除自身(允许留在原孔)。
- 验证:第一件占 [s10-30,s50-70];第二件不过滤时重复吸附(原 bug),带过滤指向已占组→null,指向空闲组→吸附空闲孔。

### 1.7 边缘圆孔自动打孔
- 装配(拖放、移动)落到 `covered`(未打通)候选圆孔时,`toggleEdgeHole` 自动 `knocked=true` → 3D 板面重建为真孔、3MF 导出带孔、虚线候选标记被真孔替代。
- **本会话补齐了"手动旋转"路径的自动打孔**(rotateSelectedPart 落新孔组时同样 toggle)。

### 1.8 接触面(contactZ)—— 最新功能
- 问题:紧固件/挂钩只是贴附在板面,没有真正插入;用户要求"接触面与板面贴合"。
- **关键语义(用户明确,务必遵守):圆孔/长圆孔锚点点选的是"插入柱的末端"(钩子末端,进入板孔的一端);接触面点选的是"钩子的根基"(与板面贴合的基座面)。两者天生不在同一端面上——不得要求它们共面,否则零件插不进去。锚点 z 值在接触面设置后不参与定位。**
- 实现:
  - `PartMountDefinition` 新增 `contactZ?: number`(接触面局部 z,mm)。
  - 标定器「2. 选择端面」现在是三模式:`[长圆孔] [圆孔] [接触面]`;选「接触面」后单击端面 → 校验法向 |z|≥0.95(应与板面平行)→ 记 `contactZ`(高亮显示 + 状态行"接触面已设置:局部 z = …");改变默认朝向时接触面与锚点一并清空;保存时随 `anchors/orientation` 一起提交。
  - 服务端(`vite.config.ts` 标定端点):`Number.isFinite(body.contactZ)` 则写入 `manifest.mount.contactZ`,否则删除。
  - `fitPartAnchors` 新增 `contactZ?: number`:zOffset = `target.z - contactZ`(接触面精确贴合板面;缺省退回"锚点平面贴合"旧行为)。`contactZForSide` 处理背面翻转(与锚点 z 翻转规则一致)。
  - 验证(数值):锚点在凸台端 z=3、接触面在基座背面 z=-3、板面 z=4 → 无接触面 z=1(旧行为),有接触面 z=7(基座背面落 z=4,螺栓插入)。
- 遗留讨论项(未实现,作为"可选未来"):显式"插入深度 = 板厚"参数;180° 装配合法性需外形碰撞检测(锚点体系无法区分)。

---

## 2. 当前数据模型(最新)

```ts
interface PartMountAnchor {
  id: string; label?: string
  accepts: Array<'slot' | 'round' | 'either'>
  position: [number, number, number]   // 零件局部坐标(mm)
  normal?: [number, number, number]
  axis?: [number, number]              // ← 新增: 长圆孔长轴(局部安装面单位向量)
  required?: boolean
}
interface PartMountDefinition {
  mode: 'single' | 'multi' | 'edge' | 'free'
  anchors: PartMountAnchor[]
  contactZ?: number                    // ← 新增: 接触面局部 z
  calibrationRequired?: boolean
  expected?: Array<'slot' | 'round'>
}
interface PlacedPart {
  id: string; defId: string; rotation: number; params: ...
  placement?: {
    surface: 'split-panel' | 'board'
    side?: 'front' | 'back'
    panelId?: string
    position: [number, number, number]
    rotationZ: number
    targetIds: string[]                // 占用孔位 id 清单(占用判断数据源)
  }
}
interface AssemblyTarget {
  id: string; panelId: string; kind: 'slot' | 'round'
  x: number; y: number; z: number
  axis?: [number, number]              // 板面槽孔长轴, 恒为 [0,1]
  covered?: boolean                    // 候选圆孔未打通
  source?: { panelX: number; panelY: number; holeX: number; holeY: number }
}
```

---

## 3. 当前待办 / 已知问题

1. **误锚点清理**:`配件资源包/我的配件/parts/40直钩子-mt5n0uxc/part.json` 中有一个**多余的锚点 a4** `[0, 19.799, 7]`(旧 UI 时代用户点"根基"被记成了锚点),它与 a3 `[0, 7.75, -2.99]` 的 XY 距离仅 12mm,而板面最小孔距 28.28mm → 刚体配准永远无解,该零件吸不上。用户操作:标定器「撤销上一个」删 a4 再保存。可考虑(可选):配准失败提示中给出"某锚点间距异常"的归因,或标定器提示锚点间距小于板面最小孔距。
2. **服务端配置生效**:`vite.config.ts` 的改动(contactZ 写入、findPartManifest)需要**重启 dev server**;`src/` 改动 Vite 热更新即时生效。
3. 可选未来:插入深度显式参数;外形碰撞检测(区分 0°/180° 装配是否遮挡);跨件孔位冲突的 2D 提示。

---

## 4. 硬性约束(勿违反)

- **不要**把锚点平面与接触面强制共面(二者天生不同面);接触面设置后,装配 z 只由 `contactZ` 决定,锚点 z 不参与。
- **不要**回退:大类目录扫描模式、散件归一化、弹窗限高+Portal、退出系统、findPartManifest 双布局、长轴定向吸附、孔位全局占用、自动打孔(含旋转路径)。
- 板面规格孔全部为**竖向** 5×15 胶囊(`axis:[0,1]`);任何"横向槽"设计当前不支持(轴约束会正确地拒绝)。
- 刚性配准不缩放模型;孔距不一致(>4mm 容差)即拒吸附。
- 占用判断:孔为穿板贯通孔,正/背面共用一组孔,一件件占用,移动/旋转时排除自身。
- 修改 `vite.config.ts` 后必须提醒用户重启;`tools/vite-sandbox-preload.cjs` 仅为本机 AI 调试环境使用(沙箱禁子进程管道 stdio 的绕过),与产品无关,可删。
- 文字(UI 文案/注释)保持中文。

---

## 5. 验证方法(沿用)

- `npx tsc -b` 必须 0 退出。
- 纯逻辑验证可直接 `node <xxx>.mjs` 导入 `src/utils/assemblySnap.ts`(Node 24 原生 type-stripping 支持 .ts;该文件仅 type-only 导入,可直接跑):
  - 轴向:正确布局应吸附、90° 调换布局应被拒;对照"去掉 axis"复现旧 bug。
  - 占用:第二件不得复用第一件 targetIds,指向空闲孔组可正常吸附。
  - 接触面:zOffset = target.z − contactZ(正面)/ 翻转公式(背面)。
- 三维/射线逻辑(deriveSlotAxis)可用 three.js 无头(Node 可 import three)构造几何验证。

---

## 6. 持续开发与发布记录（每次修改必须执行）

后续 AI 或开发者接手时，先阅读 [`DEVELOPMENT_GUIDE.md`](DEVELOPMENT_GUIDE.md)，再开始改代码。每次修改都必须同时留下“问题 → 假设 → 代码/数据 → 验证 → 限制”的证据链：

1. 记录用户问题、可验收标准、输入样本和影响模块；
2. 修改 `Split`、孔位、装配或 3MF 时，运行对应 `verify-*.mjs`，保存数量、间距、覆盖率、接缝、占孔和导出结果；
3. 修改 3D、纹理或配件库时，记录模型格式、材质/颜色、锚点/接触面、预览视角和前后截图；
4. 更新 [`TECHNICAL_EVOLUTION.md`](TECHNICAL_EVOLUTION.md)、[`CHANGELOG.md`](CHANGELOG.md) 和受影响的 `apps/wiki/docs/` 指南；
5. 新增第三方模型/图片时，先登记 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 的来源、作者/页面、许可证状态、测试用途和下架责任人；
6. 发布前运行 `npm run lint`、官网/设计器构建和专项回归，并记录 EdgeOne 预览地址、环境变量是否更新、生产部署结果和回滚提交；
7. 不把 EdgeOne API Token、个人联系方式、商业预算或未授权素材写入代码、`.env.example` 或公开文档。

当前线上架构是两个 EdgeOne Pages / Makers 项目：仓库根目录的 `edgeone.json` 发布官网，`snapboard-v2/edgeone.json` 发布独立设计器。官网与设计器的 `VITE_*_URL` 只填写公开地址；配件导入、项目库写回等 `/api/*` 能力仍依赖本地 Vite middleware，未部署后端前不得描述为云端协作功能。
