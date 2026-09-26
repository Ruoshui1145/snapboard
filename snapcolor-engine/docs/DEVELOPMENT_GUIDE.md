# SnapColor Engine 开发指南

更新时间：2026-08-31

## 1. 当前定位

`snapcolor-engine/` 是 SnapBoard 仓库内的独立研发项目，当前没有接入 `snapboard-v2`：

- 不属于根 npm workspace；
- 不修改 SnapBoard 当前纹理入口；
- SnapBoard 现阶段继续使用已有颜色流程；
- 新引擎失败、构建或删除不会影响当前软件；
- 只有通过实物校准、切片器验证和整合门槛后才允许接入。

开发入口：

```powershell
cd D:\自动切片设计软件\snapcolor-engine
npm run dev:ui
```

默认地址：`http://127.0.0.1:24681/`

Windows一键启动：

```text
D:\自动切片设计软件\启动SnapColor校色测试台.cmd
```

启动器会检查端口、补齐依赖、隐藏运行Vite服务，并打开`/#calibration`。运行状态、PID和日志保存在`snapcolor-engine/.runtime/`；停止入口为`snapcolor-engine/停止 SnapColor 校色测试台.bat`。

## 2. 目录结构

```text
snapcolor-engine/
├─ src/
│  ├─ color/          sRGB、XYZ、Lab、CIEDE2000
│  ├─ profile/        profile运行时验证
│  ├─ recipes/        有序配方枚举与光学基色剪枝
│  ├─ predictors/     模拟/实测配方目录
│  ├─ optimizer/      配方匹配、空间连续性、基色候选排序
│  ├─ layers/         层号×材料掩膜编译
│  ├─ calibration/    manifest、E0–E5规划、双背衬拟合
│  ├─ compiler/       端到端编排
│  └─ export/         标准3MF校准板
├─ ui/
│  ├─ App.tsx                 转换实验台
│  ├─ CalibrationWizard.tsx  六步校准向导
│  ├─ ProductLab.tsx         工艺衍生产品页面
│  ├─ styles.css             主测试台样式
│  └─ calibration.css        校准/产品样式
├─ schemas/          snapcolor-profile/v1 JSON Schema
├─ examples/         仅供开发的simulation-only profile
├─ tests/            数学、配方、规划、拟合、3MF测试
└─ docs/             架构、校准、独立性、整合和产品路线
```

## 3. 图形化工作台

### 3.1 转换实验

功能：

- 导入图片；
- 选择两色/四色模拟profile；
- 编辑材料显示色和模拟遮盖率；
- 配置光学基色、固定层位和最少层数；
- 对候选基色进行排序；
- 运行Lab/ΔE00配方匹配；
- 查看目标、预测和逐层材料mask；
- 模拟孔位避让；
- 生成标准校准3MF。

### 3.2 校准向导

六步状态机：

```text
锁定工艺
→ 实验设计
→ 采集白/黑底照片
→ 标记四角
→ 双背衬拟合与质检
→ 保存材料原型档案
```

当前已实现：

- 打印机、喷嘴、层高、温度、流量、速度、构建板、朝向、干燥和批次形成工艺指纹；
- E0–E5实验阶段；
- 分层覆盖、重复样、盲留出样和可复现种子；
- 白/黑底照片上传；
- 左上→右上→右下→左下四角标记；
- 投影变换后的色块中心稳健采样；
- TD10、单层遮盖、透射RMSE、曝光裁切和单调性警告；
- 将拟合结果写入材料`opticalCalibration`。

### 3.3 工艺产品

当前展示并排序：

- 可更换装饰表皮；
- 异形校园导视板；
- 昼夜双态灯光板；
- 打印农场校色认证；
- 耗材批次profile市场；
- 触觉彩色信息板。

该页面是研发决策看板，不代表产品已经验证或可以宣传上市。

## 4. 三类基材语义

开发时禁止继续使用一个模糊的`baseColor`表示全部底层：

| 概念 | 代码/数据语义 |
|---|---|
| 结构基材 | 5mm板体、孔壁、强度与真实生产情境 |
| 反射背衬 | 白/黑/灰光学基底，参与反射与透射 |
| 光学基色 | 有序配方内固定或至少出现的锚定材料 |

现有`opticalBase`支持：

- `materialId`；
- `fixedLayerIndices`；
- `minimumLayerCount`；
- `allowAdditionalLayers`。

例：四色五层、L5固定白色后，候选从`4^5=1024`降为`4^4=256`。

## 5. E0–E5实验规划器

入口：`src/calibration/experimentPlanner.ts`

算法顺序：

1. 应用光学基色硬约束；
2. 根据阶段限制材料种数和换色结构；
3. 覆盖每个可行“层位×材料”；
4. 覆盖A→B和B→A有序相邻材料对；
5. 覆盖不同材料数、换色数和基色层数的分层；
6. 用最大最小汉明距离填满剩余预算；
7. 按分层选择盲留出样；
8. 生成重复样；
9. 用确定性种子打散热床位置；
10. 输出可直接交给标准3MF生成器的manifest。

任何参与拟合的样本不能同时作为独立验证证据。

## 6. 双背衬拟合

入口：`src/calibration/dualBackingFit.ts`

V1模型：

```text
T(t) = exp(-k × t)
TD10 = ln(10) / k
```

白底/黑底差值用于估计`T(t)`，再拟合：

- `attenuationPerMm`；
- `transmissionDistance10Mm`；
- `opacityPerOpticalLayer`；
- `estimatedMaterialRgb`；
- `transmittanceRmse`；
- 每个厚度点残差和警告。

该模型是低参数候选生成器，不是最终颜色真值。正式结果必须由有序组合实测与留出样校正。

## 7. Profile等级

- `simulation-only`：只验证软件、层序和文件结构；
- `measured-prototype`：已有自主数据，但设备/重复性/留出验证不完整；
- `validated`：来源、重复性、留出验证、真实结构板和切片器检查全部完成。

禁止自动升级等级。正式档案至少需要：

- 色卡3MF和manifest哈希；
- 原始图片/仪器数据哈希；
- 材料与工艺指纹；
- 重复样统计；
- 盲留出结果；
- 真实孔边/接缝情境验证；
- Bambu Studio与OrcaSlicer打开验证。

## 8. 3MF边界

当前`standard3mf.ts`只生成：

- 3MF Core；
- Materials and Properties基础材料；
- SnapColor自有profile与manifest metadata。

不包含：

- 第三方完整工程模板；
- 未经独立验证的厂商私有字段；
- 旧LUT或NPY数据。

未来Bambu/Orca适配器必须与标准核心分开；适配失败时降级为“标准几何＋用户在切片器选择工艺”，不能回退复制旧模板。

### 8.1 当前Bambu本地适配器

`scripts/bambuProjectAdapter.ts`只在本地Vite测试服务中运行：

1. 浏览器生成自主标准3MF；
2. 标准3MF将全部“层×材料”网格组织为一个父对象的多个子部件；
3. 本地服务调用用户已安装的Bambu Studio官方CLI重新保存工程；
4. 读取官方生成的`project_settings.config`和`model_settings.config`；
5. 写入SnapColor自己的4个PETG颜色槽、0.08mm层高和子部件—耗材映射；
6. 把SnapColor profile和manifest重新放入工程包；
7. 返回`.bambu.3mf`下载。

项目不保存或分发Bambu完整模板。Bambu Studio升级后，通过本机官方CLI重新生成兼容骨架。默认搜索常见安装路径，也支持环境变量`BAMBU_STUDIO_EXE`。

当前P1S/P1P类240mm单盘样例验收：

- 256配方；
- 16×16；
- 13mm色块、1mm间隔；
- 1个父对象、18个材料子部件；
- 1盘；
- 4个PETG槽；
- 0.08mm首层与层高；
- 245℃喷嘴、70℃纹理PEI默认值；
- extruder 1–4均有实际子部件引用。

这些温度是当前测试默认值，发送打印前仍须按实际PETG和工艺指纹确认。

## 9. 测试与构建

完整验证：

```powershell
npm run verify
```

它依次执行：

1. TypeScript引擎构建；
2. Node单元测试；
3. 运行代码许可证边界扫描；
4. UI类型检查；
5. Vite生产构建。

当前基线（2026-08-31）：

- 19项测试通过；
- 15个运行文件通过许可证边界扫描；
- UI生产构建通过；
- 浏览器实测完成六步向导、E0–E5规划、双背衬拟合、材料保存和产品页；
- 控制台无错误；
- 720px视口无横向溢出。

## 10. 知识产权边界

允许依据：

- 公开标准；
- 公开论文中的数学原理；
- 自主设计的数据结构和代码；
- 自主打印、拍摄和测量的数据。

禁止进入闭源核心：

- Lumina GPL代码；
- Lumina `.npy/.npz` LUT和配方筛选数据；
- Lumina/Bambu完整配置模板；
- Lumina校准板具体排列资产；
- 未公开2.0拟合模型的推测性仿写；
- 来源不明的材料profile。

每个新增算法、依赖和数据源都必须更新`INDEPENDENCE_LOG.md`与`THIRD_PARTY_NOTICES.md`。

## 11. SnapBoard整合门槛

整合前必须同时满足：

1. SnapBoard现有普通打印仍通过；
2. SnapColor完整验证通过；
3. 至少一套自主`measured-prototype`；
4. 校准图和独立验证图完成实物复测；
5. 孔位、接缝和配件遮挡情境验证；
6. Bambu/Orca对象、材料和层序检查；
7. SnapColor任何失败不阻止`plain/veneer`导出；
8. 旧第三方模式只读迁移，不在新项目写回。

## 12. 关键提交

- `d5f64bd`：建立独立颜色引擎；
- `12018ee`：建立图形化测试台；
- `6521794`：加入校准工作流、实验规划和工艺产品路线。

## 13. 下一步

1. 根据实际打印机创建真实工艺profile；
2. 生成第一卷PETG白/黑底梯度卡；
3. 完成E0摄影重复性；
4. 对四卷候选PETG逐卷建立材料原型；
5. 比较白/青/品红/黄作为光学基色；
6. 生成E2层序实验与E5分层组合板；
7. 导入自主实测Lab/光谱；
8. 完成真实5mm板、孔边和接缝验证；
9. 再设计SnapBoard适配层。
