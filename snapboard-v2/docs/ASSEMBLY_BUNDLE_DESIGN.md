# 主配件、附属件与分步自动装配设计

更新时间：2026-08-30  
状态：设计提案，当前单件装配仍以 `PartMountDefinition` 为运行时接口。

## 1. 问题定义

洞洞板配件经常不是一个单独打印件，而是：

- 主配件：托盘、挂钩、收纳盒等功能件；
- 通用附属件：插入板孔的连接键、背面锁扣、螺钉或卡榫；
- 装配关系：多个打印件以确定变换组合预览，但切片时应作为独立对象打印；
- 安装动作：对孔、插入、贴面、沿长孔方向滑移、卡止。

当前 `part.json` 只有一个预览模型、一个制造模型和一组静态锚点，不能完整表达这些关系。

![主配件、通用附属件与独立打印对象](assets/part-bundle-workflow.svg)

## 2. STEP 与 3MF 的角色

### STEP

STEP 不是“把两个 STL 拼接起来”的文件。它保存 B-Rep 实体、零件层级和装配变换，适合 CAD 交换；STL 只有三角网格。当前网页加载器不支持直接读取 STEP，导入 API 也没有把 STEP 转成可渲染网格。

推荐流程：

```text
STEP/装配体源文件
    ↓ OpenCascade/桌面或服务端预处理
组件树 + GLB 预览 + 3MF/STL 制造网格
    ↓
SnapBoard 资源包
```

STEP 可以作为 `model.source` 归档，但在引入 OpenCascade/WASM 或服务端转换前，不能直接拿 STEP 做浏览器装配和 3MF 输出。

### 多部件 3MF

3MF 可以保存多个 object、components 和 build item 变换，适合表达“整体预览、分件打印”。当前 ThreeMFLoader 能加载层级，导入检查器也能选择 `renderNode`，但制造导出会遍历并归一化整个模型，还没有把输入 3MF 的每个组件作为独立可打印对象保留下来。

后续应解析：

- resources/object；
- components/component 引用；
- build/item 变换；
- 每个组件的名称、数量、材料和可打印状态；
- 是否整体预览、独立打印或明确布尔合并。

## 3. 建议资源模型

```ts
interface PartBundleDefinition {
  primary: PartComponentRef
  companions: PartComponentRef[]
  assembly: BundleAssemblyDefinition
}

interface PartComponentRef {
  id: string
  role: 'primary' | 'connector' | 'fastener' | 'optional'
  /** 可引用同包组件，也可引用通用资源包中的共享零件。 */
  partId?: string
  preview?: string
  print?: string
  quantity: number
  transform: {
    position: [number, number, number]
    rotation: [number, number, number]
  }
  exportMode: 'separate' | 'component' | 'merge'
}
```

通用连接键应通过稳定的 `partId = packageId:localId` 引用，不要在每个托盘目录复制一份模型。项目文件需要保存依赖版本，导出时解析数量并写入 BOM/3MF 实例。

## 4. 分步装配模型

洞洞板装配的自由度可以限制为少数阶段：

```ts
interface MountKinematics {
  /** 第一步：沿板面法向插入。 */
  insertAxis: [number, number, number]
  insertDistance: number
  /** 第二步：沿长圆孔长轴滑移，正负号区分向上/向下。 */
  slideAxis: [number, number, number]
  slideDistance: number
  /** 最终接触面。 */
  contactZ?: number
  /** 简化卡止接触，用代理体而不是首版就做全网格碰撞。 */
  latch?: {
    type: 'plane' | 'capsule-wall' | 'box'
    clearance: number
  }
}
```

推荐求解过程：

1. 对孔：锚点刚体配准到目标圆孔/长圆孔；
2. 定向：长孔 `axis` 与目标孔长轴平行，排除 90° 错装；
3. 插入：零件沿板面法向移动到锚点进入孔中；
4. 贴面：`contactZ` 与板面重合；
5. 滑移：沿目标长孔轴向做有符号移动；
6. 卡止：挂钩内侧代理面接触孔内侧/板背面，停止移动；
7. 保存最终变换、占用孔和装配阶段。

这个模型比自由 6DoF 碰撞求解稳定，也符合大多数洞洞板挂钩的真实动作。

### 调研依据与适用边界

- IKEA SKÅDIS 官方产品说明写明挂钩装上后需要转到位，官方装配图也展示了插入与转动/落位动作。这说明洞洞板附件并非全部使用同一种锁止运动，不能对未知零件盲目执行自由旋转。[IKEA 产品页](https://www.ikea.com/us/en/p/skadis-hook-white-20519888/) · [官方装配 PDF](https://www.ikea.com/cz/en/assembly_instructions/skadis-hook-white__AA-2293142-1-2.pdf)
- 细长槽孔/挂钩类结构的公开专利描述了构件插入长槽后通过相对移动进入锁止位置，与本项目“插入、贴面、向下滑移”的受限运动一致。[US5490650A](https://patents.google.com/patent/US5490650A/id)

因此首版只对本项目明确的竖直 5×15 长孔自动计算下滑；纯圆孔仍可自动对孔、插入和贴面，但下滑为 0。旋拧式或未知结构保留人工标定，不假设它们也应向下滑移。

## 5. 标定器交互建议

参考洞洞板保持固定，零件按阶段移动：

- 孔位标定完成后锁定目标孔；
- “插入”滑块/播放按钮沿法向移动零件；
- 到达接触面后自动进入“沿长孔滑移”；
- 正式 5×15 长孔固定向下滑移，用户只微调锁止距离，不提供容易造成误解的横向/纵向或上下方向开关；
- 正面/背面镜像统一经过 `assemblySide` 转换，不能单独翻图片或标记；
- 预览显示装配前、插入中、贴面、锁止四个阶段。

首版碰撞不需要遍历完整三角网格。可以由标定面、胶囊孔壁和简单 Box/Capsule 代理体完成，后续再加入 BVH 精确检查。

当前 P0 已采用代理碰撞求解：板面使用薄 Box 碰撞层；点选安装柱端面时记录 `profile.width/profile.length`。插入阶段在 `contactZ` 碰到板面时停止；竖直 15 mm 长孔的下滑停止距离为 `(15 - 安装柱长度) / 2`，多个长孔取最先碰底的最小距离。只有圆孔的紧固件沿用同一流程，但没有长孔滑移自由度，因此 `slideY = 0`，贴面后直接完成。

![代理碰撞装配三阶段](assets/assembly-collision-flow.svg)

默认界面只保留“选择孔位/接触面 → 自动装配检测 → 保存”。朝向数值、锚点坐标、分步播放和距离覆盖集中到折叠的“高级设置”，避免标定器把所有控制同时平铺。

动画触发必须经过用户的“孔位选择完成”确认；逐个增加或撤销锚点只修改标定数据，不得重复播放。首孔负责自动法向对板和长孔竖直定向；确认后沿安装柱内法向射线识别接触面。自动识别不可靠时回退到手动点面。长孔轴没有正负方向，自动求解存在上下颠倒的手性二义性，因此提供 180° 上下翻转后按同孔位重装的快捷操作，并继续保留高级 XYZ 调整。

## 6. 制造导出

主配件和附属件在 3MF 中应是独立 object/build item：

- 相同通用连接键复用同一 object，多数量使用 instance；
- 预览装配变换不等于打印排盘变换；
- 切片时按打印朝向重新排盘；
- `merge` 只在用户明确要求且布尔结果闭合时使用；
- 导出摘要显示主件、附属件、数量、材料和盘号；
- 缺少依赖或制造模型时阻止完整套件导出，不能静默遗漏锁扣。

## 7. 分阶段实现

### P0：当前 bug 修复

- 标定弹窗按 `part.id` 重建，不复用上一零件状态；
- 标定参考板与正式板的长孔统一使用竖直 `[0,1]`；
- 选择长孔锚点和接触面后自动演示“插入→贴面→向下滑移”；
- 保留分步按钮和 `slideY` 数值/滑块微调；5×15 长孔与约 5 mm 安装柱的默认下滑距离为 5 mm；
- 保存安装柱端面代理尺寸，自动计算碰底行程；纯圆孔紧固件自动使用 0 mm 下滑；
- 默认界面化简为定位、自动检测、保存三步，其余控制折叠到高级设置；
- 新增“孔位选择完成”提交点，禁止逐孔触发动画；首孔自动转向、确认后自动读接触面，失败回退手动；
- 保留上下手性 180° 翻转与高级 XYZ 微调；
- 服务端保存前统一 slot axis，并保存锁止下滑距离。

### P1：受限分步装配

- 增加 `MountKinematics`；
- 参考板固定，零件支持插入、贴面和向下滑移；
- 保存最终滑移量和方向；
- 用平面/胶囊代理体做卡止检测。

### P2：主件 + 通用附属件

- 扩展资源包 schema；
- 依赖解析、版本校验、BOM；
- 3D 整体预览；
- 3MF 独立对象和实例导出。

### P3：多部件 3MF / STEP 预处理

- 读取 3MF components/build item 树并允许拆件；
- OpenCascade/WASM 或服务端 STEP 转换；
- 用户确认组件角色、制造朝向和是否参与装配；
- 精确碰撞作为可选验证，不阻塞基础工作流。
