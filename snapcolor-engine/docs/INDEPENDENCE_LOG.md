# 独立实现记录

## 2026-08-30：项目建立

- 建立独立目录，不加入现有应用构建；
- 运行时代码从空文件开始编写；
- 色彩数学依据 sRGB、CIE XYZ/CIELAB和CIEDE2000公开规范；
- profile、配方、优化和层掩膜接口根据 SnapBoard 的固定平面、孔位避让和跨分板需求设计；
- 不导入任何第三方 LUT、NPY、材料配方或应用配置模板；
- 模拟预测器明确标记为非实测，不构成颜色性能声明；
- 正式数据将由 SnapBoard 自主生成的色卡和测量流程产生。
- 标准3MF ZIP容器使用MIT许可的`fflate`，已记录于`THIRD_PARTY_NOTICES.md`；
- 3MF模型、材料、关系文件和自有metadata从空数据结构生成，不使用厂商完整工程模板。

## 参考规范

- ICC sRGB Registry: https://registry.color.org/rgb-registry/srgb
- CIEDE2000: https://www.cie.co.at/publications/colorimetry-part-6-ciede2000-colour-difference-formula-1
- 3MF Specification Suite: https://3mf.io/spec/

每次引入新的算法、测试向量、依赖或测量数据时，都必须在本文件记录来源、许可证、版本和用途。

## 2026-08-31：自主校准工作流

- 依据公开色彩科学和双背衬测量原理，从空代码实现指数衰减基线；
- 新增E0–E5实验规划器，自主设计分层覆盖、汉明距离补样、盲留出和重复样逻辑；
- 图形化向导只参考公开工作流需求，未复制第三方UI、校准板布局或schema；
- 增加工艺指纹、照片四角、投影采样、曝光裁切、RMSE与单调性警告；
- 正式数据仍为空，所有演示照片和profile明确为模拟数据；
- 新增技术来源与产品假设分别记录在`CALIBRATION_WORKFLOW.md`和`PROCESS_PRODUCT_ROADMAP.md`。
