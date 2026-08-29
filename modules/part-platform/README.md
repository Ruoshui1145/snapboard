# Part Platform

当前开发指南：[`docs-internal/architecture/DEVELOPMENT_GUIDE.md`](../../docs-internal/architecture/DEVELOPMENT_GUIDE.md)

## 当前职责

- 8 个配件大类和资源包扫描；
- 3MF/STL/GLB/GLTF 模型导入、改名、移动和删除；
- 模型缩略图；
- 模型渲染缩略图与实装照片分离；
- 实装照片上传替换、缓存规避和删除；
- 长圆孔、圆孔、接触面和默认朝向标定；
- 同一配件已有一致长孔方向时，资源同步自动补齐缺失 `axis`；
- `.sbpack` 打包、许可、版本和社区兼容字段。

## 当前实现

`src/partLibrary`、`components/partLibrary`、`hooks/usePartLibrary.ts`、`scripts/sync-part-library.mjs`、`配件资源包/`。

资源同步器会将 `thumbnail` 用于卡片封面，将 `model.usageImage` 用于展开预览中的实际安装照片。`usage-*`、`assembly-*`、`install-*`、`photo-*` 文件不会被当作模型封面。
