# SnapBoard 零件资源包

真正给用户投放模型的目录已经移到项目根部：`配件资源包/`。每个一级文件夹是一个可分享的社区包，包含 `pack.json`、`parts/` 和 `designs/`。

把 SolidWorks 导出的固定零件放入 `配件资源包/官方基础配件包/parts/对应零件/`。开发服务器运行时会自动同步，也可以手动运行：

```bash
npm run parts:sync
```

推荐直接导出 **3MF（毫米、Z 轴向上）**。也支持 GLB/GLTF 和 STL。网页实际读取的 `public/partLibrary/community-assets/` 和 `index.json` 都是自动生成缓存，不需要手动管理。

文件优先级：`preview.glb` → 任意 GLB/GLTF → 任意 3MF → 任意 STL。STEP/STP/SLDPRT 会作为源文件记录，不在第一阶段直接加载。
