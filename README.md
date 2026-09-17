# 泊车雷达 ParkingPH

菲律宾停车场地图：定位或搜索目的地，列出附近停车场，网页内导航（中文/英文转向提示与语音、偏航自动重算），或一键交给 Google Maps / Waze。手机与电脑自适应。

线上：https://jyb635050-ai.github.io/parking-ph/

## 数据与服务
- 停车场：© OpenStreetMap 贡献者，ODbL 1.0。全菲 `amenity=parking` 与 `amenity=motorcycle_parking` 中只收**正规公共停车场**：剔除 `access=private/no` 和 `fee=no`，且必须标了收费（fee/charge）、或是立体/地下/楼顶停车楼、或有运营方（operator）。全国约 1,660 个；OSM 很少标收费，没这些标签的真实收费停车场会漏掉。
- **大马尼拉逐个交叉验证**（2026-09-17 数据）：从 OSM 全部 3,290 个可用停车场里，用四路证据核对真实性——OSM 标签、周边商场/医院/写字楼/车站等地标、Wikidata 独立收录的地标、停车场入口节点，再加 **Esri 卫星图人工逐张目检 900 个**（结论在 `tools/ncr_satellite_review.json`）。收录 746 个：501 个卫星图核实（可见车位/停车楼），245 个多源旁证（停车楼天上看不到，或树冠遮挡但有专用入口＋地标）。卫星图明确不是停车场的一律剔除。重现：`python tools/ncr_fetch.py` → `python tools/ncr_evidence.py` → `node tools/build_data.mjs`。数据时间见页面底部与 `data/parking.json` 的 `meta.osm_base`。不含实时空位与价格。
- 重建数据：`node tools/build_data.mjs`（用缓存）/ `--refresh`（重新查 Overpass，只接受比缓存更新的结果）。
- 算路：FOSSGIS 的 Valhalla（`valhalla1.openstreetmap.de`，汽车/摩托车）为主，OSRM 演示服务器（`router.project-osrm.org`，仅汽车）备用。两者均为非商用、每秒不超过 1 次请求，页面按服务器限速。
- 搜索：Photon（komoot）。底图：OpenFreeMap（OpenMapTiles）。前端：MapLibre GL JS。

## 限制
- 手机锁屏后网页拿不到定位，长途请用 Google Maps / Waze。
- 语音用浏览器自带朗读，设备没有对应语言语音时只显示文字。

## 验收
`node tools/accept.mjs`（本地）、`--url https://jyb635050-ai.github.io/parking-ph/`（线上）、`--prove`（屏蔽算路，必须失败）。判卷脚本冻结，SHA256 `4ECEC73A5F432B02C0353060880BF5684816254EB5EB264D7E8F109C746885E5`。
