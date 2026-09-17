# PROGRESS

## 开工回执（2026-09-16）
- 目标：菲律宾停车场地图网页（附近/目的地附近找停车场 → 网页内导航 / 跳 Google Maps、Waze），手机电脑都好用，上线 jyb635050-ai.github.io/parking-ph
- 顺序：数据(D1–D6) → 地图页(W/S/M 非导航项) → 导航(W11–W22, M7–M8, G) → --prove 反向验证 → 上线 --url 全绿
- 最大风险：导航跟随/重算在模拟定位下的时序（watch 与 getCurrentPosition 冲突）；Overpass 镜像不稳定
- 任务 0：accept.mjs SHA256 = 7F7E13FB…AB5ED 一致；空目录跑判卷 3/8 PASS 5 FAIL 退出码 1；OpenFreeMap/MapLibre CDN/Photon/Valhalla/OSRM 均 200；Overpass kumi 此刻超时（000，60s）——与书中"镜像不稳"一致，不阻断：用今天已抓到的原始响应作缓存

## 进度
- 任务 1：tools/build_data.mjs 完成。--refresh 实测 kumi 返回 osm_base 2026-05-06（比缓存 06-01 旧）并覆盖了缓存 → 已回滚到 06-01 版本，脚本改为只接受更新的数据。现 data/parking.json 13730 条（汽车 13127／摩托 603），2.10 MB
- 任务 2/3：index.html + css/app.css + js/{i18n,routing,app}.js 完成；本地判卷 44/44 PASS（shots/run-local.txt）；截图目检后改了详情页空字段、低缩放点位大小、导航时隐藏右上 HUD，复跑仍 44/44
- 反向验证：`--prove` 退出码 1（W11、M7 FAIL），输出存 shots/run-prove.txt
- 任务 4：公开仓库 jyb635050-ai/parking-ph，Pages 已 built；线上 data/parking.json 字节数与本地一致（2197511）；`--url` 线上判卷 43/43 PASS 退出码 0（shots/run-live.txt）；accept.mjs 本地与 git 中 SHA256 均为 7F7E13FB…AB5ED
- 额外自查（线上）：Santo Tomas, Batangas 定位列出 30 个、无 null/undefined、无私人停车场；导航播报中文语音、申请了屏幕常亮；英文模式指令为英文；页面有 OSM 署名与数据日期 2026-06-01
- 状态：全部完成
- 2026-09-17 需求变更（领导）：只保留正规收费公共停车场 → 1390 条（汽车 1256／摩托 134）。判卷 D2/D3 门槛下调并新增 D7，新 SHA256 C6E8972597FD3DBB69B3140A26A3B1F82245D386CE6A408AC5B9992A750A691B；本地 45/45 PASS；D7 反向验证（塞一条 fee=no）退出码 1
