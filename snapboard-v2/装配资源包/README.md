# SnapBoard 装配宿主资源包

本目录只保存“被安装到什么上面”的宿主规格，例如洞洞板、DIN 导轨、铝型材槽和墙面。
普通挂钩、托盘、紧固件仍放在 `配件资源包/`，可打印模型不得混入本目录。

```text
装配资源包/
  00-SnapBoard洞洞板体系/
    pack.json
    hosts/<host-id>/host.json
  10-DIN导轨体系/
  20-铝型材体系/
  30-墙面安装体系/
```

规则：

- `pack.json.kind` 固定为 `assembly-host-pack`；
- 每个宿主单独一个 `host.json`，`id` 和 `compatibilityKey` 必须全局唯一；
- 名义“槽 8”不构成跨厂商兼容依据，不同体系使用不同 `systemKey`；
- `sources` 必须指向官方标准、制造商目录或产品页；
- 胶粘、微钉和螺钉的几何匹配不代表承重保证；
- 运行 `npm run assembly:sync` 生成网页只读索引。

## 设置中心导入格式

设置中心接收一个自包含 JSON bundle，不接收任意文件夹路径：

```json
{
  "format": "snapboard-assembly-host-bundle",
  "schemaVersion": 1,
  "package": {
    "kind": "assembly-host-pack",
    "id": "example.hosts.profile",
    "name": "示例型材宿主",
    "version": "1.0.0",
    "author": "Local User",
    "license": "Private"
  },
  "hosts": [
    {
      "id": "example-profile",
      "schemaVersion": 1,
      "kind": "t-slot",
      "label": "示例型材",
      "summary": "仅用于说明 bundle 结构。",
      "status": "planned",
      "family": "aluminium-profile",
      "connectorKind": "t-slot",
      "compatibilityKey": "example:profile:v1",
      "systemKey": "example-profile",
      "standard": null,
      "nominalGeometryMm": { "openingWidth": 8 },
      "occupancy": { "kind": "axis-interval", "clearanceMm": 0.5, "collisionPolicy": "reject-overlap" },
      "recipe": [{ "id": "verify", "action": "verify", "label": "验证兼容性", "automaticByDefault": true, "stopCondition": "验证通过", "manualFallback": "人工复核" }],
      "validation": { "geometryChecks": [], "requiredMetadata": [], "loadRatingPolicy": "manufacturer-data-required" },
      "interchangeability": { "crossSystemAutomaticMatch": false, "notes": [] },
      "sources": []
    }
  ]
}
```

实际 `hosts` 项仍须满足 `schema/host.schema.json`。导入器会拒绝已有包 ID、宿主 ID 或兼容键，不覆盖现有数据。
