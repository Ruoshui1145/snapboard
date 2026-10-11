# SnapBoard 个人玩家版

Windows x64，连接生产额度服务，每个设备每天10次制造导出（北京时间零点更新）。完整多盘或分板任务计一次；取消/失败不计，重复领取同一任务不会再计。

运行环境随安装程序携带。默认数据位于 `%APPDATA%/SnapBoard DIY/workspace`，卸载保留数据。首用和每天换新额度需联网；图纸、图片和制造文件留在本机。

此包没有农场订单后台，不内置个人或第三方Private配件集合。可从设置导入自己的模型。

开发者：根目录 npm ci；npm run build:diy；在 desktop 中运行 npm run prepare:app。受信任发行签名必须由发行维护者另外提供，未签名的payload不能启动。之后在 desktop 中 npm run dist。
