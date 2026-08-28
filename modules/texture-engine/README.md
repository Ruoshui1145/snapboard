# Texture Engine

## 当前职责

- 内置纹理、材质贴面和自定义图片；
- 图片平移、缩放、边框和连续全局 UV；
- Lumina LUT/颜色映射；
- 结构基层与约 1 mm 彩色/质感表层；
- 孔洞、上下倒角和板件边界的布尔裁切。

## 当前实现

`components/texture/TextureStudio.tsx`、`utils/boardTexture.ts`、`luminaLut.ts`、`panelBoolean.ts`。

## 第三方边界

Lumina 原始源码和运行参考放在 `vendor/lumina-studio/`。SnapBoard 不直接修改第三方源码来承载自己的产品状态。

