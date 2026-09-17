// ParkingPH 验收脚本 —— 判卷标准，冻结，任何人不许改（改了就算不合格）。
// 用法（在 D:\blender\ParkingPH 下）：
//   node tools/accept.mjs                      本地验收（脚本自带静态服务器，服务本目录）
//   node tools/accept.mjs --url https://jyb635050-ai.github.io/parking-ph/   线上验收
//   node tools/accept.mjs --prove              反向验证：屏蔽全部算路服务器，必须出现 FAIL 且退出码 1
// 全部 PASS 退出码 0；任一 FAIL 退出码 1。截图写到 shots/（线上验收加 live- 前缀）。
//
// ───── 页面契约（index.html 必须实现）─────
// window.__map              MapLibre Map 实例（__map.getCanvas() 是地图画布）
// window.__parkingReady     地图 load 完、停车场数据已加进地图后置 true
// [data-testid=locate]      定位按钮，首屏可见；成功后以用户位置为参考点刷新附近列表
// [data-testid=geo-error]   定位失败/被拒绝时可见的提示
// [data-testid=search]      目的地搜索框；候选项 [data-testid=suggestion]，点击后以该地点为参考点刷新附近列表
// [data-testid=lot]         附近列表项，按距离升序；属性 data-lat data-lng data-kind(car|moto)
//                           data-distance-m（到参考点的直线米数）
// [data-testid=lot-detail]  点列表项后出现；内含 [data-testid=navigate]、
//                           a[data-testid=handoff-google]、a[data-testid=handoff-waze]
// [data-testid=navigate]   开始导航：起点用点击那一刻的实时定位（不是列表的参考点），之后持续跟随定位
// [data-testid=nav-panel]   导航中可见；属性 data-remaining-m（沿路线剩余米数，随定位实时更新）；
//                           内含 [data-testid=nav-instruction]、[data-testid=nav-stop]
// 地图 source 'route'        GeoJSON，当前路线 LineString，坐标 [lng,lat]
// [data-testid=route-error] 算路失败时可见
// [data-testid=mode-car] / [data-testid=mode-moto]  车型切换，首屏可见，aria-pressed="true" 表示选中
//                           汽车模式列表里不许出现 data-kind=moto
// [data-testid=lang]        中/英切换，首屏可见；<html lang> 在 zh-CN 与 en 之间切换
// data/parking.json         GeoJSON FeatureCollection，Point；properties 至少 id(唯一) kind(car|moto) name(非空字符串或 null)
//                           只收正规公共停车场（领导 2026-09-17 裁决）：fee 不是 no，且至少有 fee / chg(收费细则) /
//                           t 为 multi-storey|underground|rooftop / op(运营方) / ver=sat(卫星核实) /
//                           大马尼拉条目 why 含 ent(停车场专用入口，且整体 ≥2 类证据) 之一
//                           大马尼拉（领导 2026-09-17：多找＋交叉验证）：ncr=1 的条目带 ver(sat|multi) 与 why(证据代码，≥2 条)
// 算路只许请求 valhalla1.openstreetmap.de / router.project-osrm.org / routing.openstreetmap.de，
// 对同一台算路服务器，任意两次请求间隔 ≥ 900ms（服务条款：每秒不超过 1 次）
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('C:/Users/73405/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PROVE = args.includes('--prove');
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const SHOT = path.join(ROOT, 'shots');
const shotName = n => path.join(SHOT, (urlArg ? 'live-' : '') + (PROVE ? 'prove-' : '') + n);

const MAKATI = { latitude: 14.5547, longitude: 121.0223 };
const START = { latitude: 14.5547, longitude: 121.03342 }; // MAKATI 以东约 1.2 km，导航测试的出发点
const MEGAMALL = { lat: 14.58473, lng: 121.05688 };
const ROUTE_HOSTS = ['valhalla1.openstreetmap.de', 'router.project-osrm.org', 'routing.openstreetmap.de'];
const CJK = /[\u4e00-\u9fff]/g;

let fails = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function hav(aLat, aLng, bLat, bLng) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function offset(lat, lng, meters, bearingDeg) {
  const b = bearingDeg * Math.PI / 180;
  return { latitude: lat + (meters * Math.cos(b)) / 111320, longitude: lng + (meters * Math.sin(b)) / (111320 * Math.cos(lat * Math.PI / 180)) };
}
function minDistToLine(lat, lng, coords) {
  let m = Infinity;
  for (const [x, y] of coords) m = Math.min(m, hav(lat, lng, y, x));
  return m;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout, step = 250) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch { /* keep polling */ }
    await sleep(step);
  }
  return null;
}

// ───── 静态服务器 ─────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain' };
async function startServer() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return srv;
}

// ───── 数据检查 ─────
async function checkData(base) {
  let fc;
  try {
    if (urlArg) fc = await (await fetch(new URL('data/parking.json', base))).json();
    else fc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/parking.json'), 'utf8'));
  } catch (e) { check('D1 data/parking.json 可读且是 JSON', false, e.message); return; }
  const feats = Array.isArray(fc?.features) ? fc.features : [];
  check('D1 data/parking.json 可读且是 FeatureCollection', fc?.type === 'FeatureCollection' && feats.length > 0, `features=${feats.length}`);
  const STRUCT = ['multi-storey', 'underground', 'rooftop'];
  let informal = 0, ncrN = 0, ncrBad = 0, coreUnverified = 0;
  const ids = new Set(); let dup = 0, badGeom = 0, outPH = 0, badKind = 0, badName = 0, car = 0, moto = 0;
  for (const f of feats) {
    const p = f.properties || {};
    if (ids.has(p.id) || p.id == null) dup++; else ids.add(p.id);
    const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) badGeom++;
    else if (c[1] < 4.2 || c[1] > 21.5 || c[0] < 116 || c[0] > 127.2) outPH++;
    if (p.kind === 'car') car++; else if (p.kind === 'moto') moto++; else badKind++;
    if (!(p.name === null || (typeof p.name === 'string' && p.name.trim().length > 0))) badName++;
    if (p.fee === 'no' || !((p.fee && p.fee !== 'no') || p.chg || STRUCT.includes(p.t) || p.op || p.ver === 'sat' || (p.ncr === 1 && Array.isArray(p.why) && p.why.includes('ent')))) informal++;
    if (p.ncr === 1) { ncrN++; if (!['sat', 'multi'].includes(p.ver) || !Array.isArray(p.why) || new Set(p.why.map(w => String(w).split(':')[0])).size < 2 || (p.ver === 'sat' && !p.why.some(w => String(w).startsWith('sat:')))) ncrBad++; }
    else if (c && c[1] > 14.53 && c[1] < 14.62 && c[0] > 121.01 && c[0] < 121.07) coreUnverified++;
  }
  check('D2 正规汽车停车场 ≥ 1200', car >= 1200, `car=${car}`);
  check('D3 正规摩托车停车点 ≥ 100', moto >= 100, `moto=${moto}`);
  check('D4 id 唯一且非空、几何都是有效 Point、全部在菲律宾范围内', dup === 0 && badGeom === 0 && outPH === 0, `dup=${dup} badGeom=${badGeom} outsidePH=${outPH}`);
  check('D5 kind 只有 car/moto，name 是非空字符串或 null', badKind === 0 && badName === 0, `badKind=${badKind} badName=${badName}`);
  check('D7 每一条都是正规公共停车场（非免费，且有收费/收费细则/停车楼/运营方/卫星核实/专用入口之一）', informal === 0, `informal=${informal}`);
  check('D8 大马尼拉交叉验证：ncr 条目 ≥ 650，每条 ≥2 类证据（卫星核实的必须有 sat 证据），马卡蒂-奥蒂加斯核心区无未验证条目', ncrN >= 650 && ncrBad === 0 && coreUnverified === 0, `ncr=${ncrN} bad=${ncrBad} coreUnverified=${coreUnverified}`);
  if (!urlArg) {
    const mb = fs.statSync(path.join(ROOT, 'data/parking.json')).size / 1048576;
    check('D6 data/parking.json ≤ 3.5 MB（手机首屏流量）', mb <= 3.5, `${mb.toFixed(2)} MB`);
  }
}

// ───── 浏览器工具 ─────
function instrument(page, log) {
  page.on('pageerror', e => log.pageErrors.push(String(e.message || e)));
  page.on('request', req => {
    let u; try { u = new URL(req.url()); } catch { return; }
    if (req.method() === 'OPTIONS') return;
    if (ROUTE_HOSTS.includes(u.hostname)) log.route.push({ t: Date.now(), url: req.url(), body: req.postData() || '' });
    else if (/\/route\b|directions/i.test(u.pathname) && !/\.(pbf|png|jpg|webp|json)$/i.test(u.pathname)) log.foreignRoute.push(req.url());
    if (u.hostname === 'nominatim.openstreetmap.org') log.nominatim.push(Date.now());
  });
}
async function blockRouting(ctx) {
  for (const h of ROUTE_HOSTS) await ctx.route(`https://${h}/**`, r => r.abort());
}
async function unblockRouting(ctx) {
  for (const h of ROUTE_HOSTS) await ctx.unroute(`https://${h}/**`);
}
async function visible(page, sel) {
  const l = page.locator(sel).first();
  return (await l.count()) > 0 && await l.isVisible();
}
async function waitReady(page, name) {
  const ok = await until(() => page.evaluate(() => window.__parkingReady === true && !!window.__map), 45000, 500);
  check(`${name} 页面就绪 (__parkingReady) ≤ 45s`, !!ok);
  return !!ok;
}
async function lots(page) {
  return page.$$eval('[data-testid=lot]', els => els.map(e => ({
    lat: parseFloat(e.dataset.lat), lng: parseFloat(e.dataset.lng), kind: e.dataset.kind, d: parseFloat(e.dataset.distanceM),
  })));
}
async function routeCoords(page) {
  return page.evaluate(async () => {
    const s = window.__map && window.__map.getSource('route');
    if (!s) return null;
    let d = typeof s.getData === 'function' ? await s.getData() : s._data;
    if (typeof d === 'string') d = await (await fetch(d)).json();
    const out = [];
    const walk = g => {
      if (!g) return;
      if (g.type === 'FeatureCollection') g.features.forEach(f => walk(f.geometry));
      else if (g.type === 'Feature') walk(g.geometry);
      else if (g.type === 'LineString') out.push(...g.coordinates);
      else if (g.type === 'MultiLineString') g.coordinates.forEach(c => out.push(...c));
    };
    walk(d);
    return out;
  });
}
async function remaining(page) {
  const v = await page.locator('[data-testid=nav-panel]').first().getAttribute('data-remaining-m');
  return v == null ? NaN : parseFloat(v);
}
async function mapShare(page) {
  return page.evaluate(() => {
    const cv = window.__map.getCanvas(); let hit = 0, n = 0;
    for (let i = 0; i < 12; i++) for (let j = 0; j < 24; j++) {
      const x = (i + 0.5) * innerWidth / 12, y = (j + 0.5) * innerHeight / 24;
      n++; if (document.elementFromPoint(x, y) === cv) hit++;
    }
    return hit / n;
  });
}
function lineLen(coords) { let s = 0; for (let i = 1; i < coords.length; i++) s += hav(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]); return s; }
function pointAt(coords, frac) {
  const total = lineLen(coords); let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = hav(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    if (acc + seg >= total * frac) return { latitude: coords[i][1], longitude: coords[i][0] };
    acc += seg;
  }
  const l = coords[coords.length - 1]; return { latitude: l[1], longitude: l[0] };
}

// ───── 桌面：定位 → 列表 → 详情 → 导航 → 跟随/防抖/偏航重算/到达 → 摩托 → 语言 → 失败提示 ─────
async function desktop(browser, base) {
  const log = { pageErrors: [], route: [], foreignRoute: [], nominatim: [] };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, geolocation: MAKATI, permissions: ['geolocation'], locale: 'zh-CN' });
  if (PROVE) await blockRouting(ctx);
  const page = await ctx.newPage(); instrument(page, log);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  if (!await waitReady(page, 'W1 桌面')) { await ctx.close(); return log; }
  check('W2 首屏默认中文 <html lang=zh-CN>', (await page.getAttribute('html', 'lang')) === 'zh-CN');

  await page.click('[data-testid=locate]');
  const L = await until(async () => { const x = await lots(page); return x.length >= 5 ? x : null; }, 20000);
  check('W3 定位后附近列表 ≥ 5 个', !!L, `n=${L ? L.length : 0}`);
  if (!L) { await ctx.close(); return log; }
  const sorted = L.every((x, i) => i === 0 || x.d >= L[i - 1].d);
  const honest = L.every(x => Math.abs(x.d - hav(MAKATI.latitude, MAKATI.longitude, x.lat, x.lng)) <= Math.max(30, 0.03 * x.d));
  check('W4 列表按距离升序，data-distance-m 与真实直线距离一致', sorted && honest);
  check('W5 最近的停车场 ≤ 1500 m（马卡蒂测试点）', L[0].d <= 1500, `nearest=${Math.round(L[0].d)}m`);
  check('W6 汽车模式列表里没有摩托车专用点', L.every(x => x.kind === 'car'));

  await page.locator('[data-testid=lot]').first().click();
  const det = await until(() => visible(page, '[data-testid=lot-detail]'), 8000);
  check('W7 点列表项出现详情', !!det);
  const g = await page.locator('a[data-testid=handoff-google]').first().getAttribute('href').catch(() => null);
  const w = await page.locator('a[data-testid=handoff-waze]').first().getAttribute('href').catch(() => null);
  const ll = (h, re) => { const m = h && h.match(re); return m ? [parseFloat(m[1]), parseFloat(m[2])] : null; };
  const gll = ll(g && decodeURIComponent(g), /google\.[a-z.]+\/maps\/dir\/\?api=1.*destination=(-?[\d.]+),(-?[\d.]+)/);
  const wll = ll(w && decodeURIComponent(w), /waze\.com\/ul\?.*ll=(-?[\d.]+),(-?[\d.]+)/);
  check('W8 Google Maps 跳转链接指向该停车场', !!gll && hav(gll[0], gll[1], L[0].lat, L[0].lng) < 15, String(g));
  check('W9 Waze 跳转链接指向该停车场且 navigate=yes', !!wll && /navigate=yes/.test(w) && hav(wll[0], wll[1], L[0].lat, L[0].lng) < 15, String(w));
  const rendered = await until(() => page.evaluate(() => window.__map.queryRenderedFeatures().filter(f => f.properties && (f.properties.kind === 'car' || f.properties.kind === 'moto')).length), 15000, 500);
  check('W10 停车场点真的画在地图画布上（queryRenderedFeatures 带 kind ≥ 1）', !!rendered, `rendered=${rendered || 0}`);

  await ctx.setGeolocation(START);
  await sleep(1500);
  const r0n = log.route.length;
  await page.locator('[data-testid=navigate]').first().click();
  const R0 = await until(async () => { const c = await routeCoords(page); return c && c.length >= 10 && log.route.length > r0n ? c : null; }, 25000);
  check('W11 开始导航：地图上画出路线（source route ≥ 10 个点）', !!R0, `routeRequests=${log.route.length - r0n}`);
  if (R0) {
    const end = R0[R0.length - 1], start = R0[0];
    check('W12 路线终点贴近停车场(≤200m)、起点是点导航时的实时位置(≤300m)', hav(end[1], end[0], L[0].lat, L[0].lng) <= 200 && hav(start[1], start[0], START.latitude, START.longitude) <= 300,
      `end→lot=${Math.round(hav(end[1], end[0], L[0].lat, L[0].lng))}m start→me=${Math.round(hav(start[1], start[0], START.latitude, START.longitude))}m`);
    const panel = await until(() => visible(page, '[data-testid=nav-panel]'), 8000);
    const rem0 = await remaining(page);
    const instr = panel ? await page.locator('[data-testid=nav-instruction]').first().innerText() : '';
    check('W13 导航面板可见，剩余距离 > 0，转向提示是中文', !!panel && rem0 > 0 && (instr.match(CJK) || []).length >= 2, `remaining=${rem0} instruction="${instr}"`);
    await page.screenshot({ path: shotName('desktop-nav.png') });

    if (lineLen(R0) >= 400) {
      const reqA = log.route.length;
      const mid = pointAt(R0, 0.5);
      await ctx.setGeolocation(mid);
      const dec = await until(async () => { const r = await remaining(page); return r <= rem0 * 0.7 + 50 ? r : null; }, 12000);
      const instrMid = await page.locator('[data-testid=nav-instruction]').first().innerText().catch(() => '');
      check('W14 沿路线开到一半：剩余距离跟着减少，转向提示跟着变', !!dec && instrMid.trim() !== instr.trim() && (instrMid.match(CJK) || []).length >= 2,
        `rem0=${rem0} now=${await remaining(page)} start="${instr}" mid="${instrMid}"`);
      for (let i = 0; i < 12; i++) { await ctx.setGeolocation(offset(mid.latitude, mid.longitude, 5, i * 30)); await sleep(1000); }
      check('W15 在路线上 GPS 抖动 12 秒不乱重算（新增算路 ≤ 1 次）', log.route.length - reqA <= 1, `extra=${log.route.length - reqA}`);
    } else {
      check('W14/W15 路线太短(<400m)，无法测跟随与防抖', false, `len=${Math.round(lineLen(R0))}m`);
    }

    let best = null;
    for (const m of [600, 900]) for (let b = 0; b < 360; b += 45) {
      const p = offset(START.latitude, START.longitude, m, b);
      const dd = minDistToLine(p.latitude, p.longitude, R0);
      if (!best || dd > best.dd) best = { p, dd };
    }
    const reqB = log.route.length;
    await ctx.setGeolocation(best.p);
    const R1 = await until(async () => {
      if (log.route.length <= reqB) return null;
      const c = await routeCoords(page);
      return c && c.length >= 2 && hav(c[0][1], c[0][0], best.p.latitude, best.p.longitude) <= 300 ? c : null;
    }, 30000);
    check('W16 偏离路线 ≥300m 后自动重算，新路线从新位置出发', !!R1, `offRoute=${Math.round(best.dd)}m newRequests=${log.route.length - reqB}`);
    if (R1) {
      const e = R1[R1.length - 1];
      await ctx.setGeolocation({ latitude: e[1], longitude: e[0] });
      const arr = await until(async () => { const r = await remaining(page); return r <= 100 ? String(r) : null; }, 15000);
      check('W17 开到终点，剩余距离 ≤ 100 m', !!arr, `remaining=${await remaining(page)}`);
    }
    await page.locator('[data-testid=nav-stop]').first().click().catch(() => {});
    check('W18 结束导航后导航面板消失', !!await until(async () => !(await visible(page, '[data-testid=nav-panel]')), 8000));
  }

  // 摩托车模式
  await ctx.setGeolocation(MAKATI);
  await page.click('[data-testid=mode-moto]');
  check('W19 切到摩托车模式 aria-pressed=true', (await page.getAttribute('[data-testid=mode-moto]', 'aria-pressed')) === 'true');
  await page.click('[data-testid=locate]');
  await sleep(3000);
  const LM = await until(async () => { const x = await lots(page); return x.length >= 5 ? x : null; }, 20000);
  if (LM) {
    await page.locator('[data-testid=lot]').first().click();
    await until(() => visible(page, '[data-testid=lot-detail]'), 8000);
    const before = log.route.length;
    await sleep(1000);
    await page.locator('[data-testid=navigate]').first().click();
    const mreq = await until(() => log.route.slice(before).find(r => /motorcycle/i.test(r.url + r.body)), 25000);
    check('W20 摩托车模式算路请求用 motorcycle 规则', !!mreq);
    await page.locator('[data-testid=nav-stop]').first().click().catch(() => {});
  } else check('W20 摩托车模式下附近列表 ≥ 5 个', false);

  // 语言
  await page.click('[data-testid=lang]');
  const en = await until(async () => (await page.getAttribute('html', 'lang')) === 'en', 5000);
  const cjk = (await page.evaluate(() => document.body.innerText)).match(CJK) || [];
  check('W21 切英文：<html lang=en>，界面文字里汉字 ≤ 20 个', !!en && cjk.length <= 20, `cjk=${cjk.length}`);
  await page.click('[data-testid=lang]');

  // 算路失败提示
  if (!PROVE) {
    await blockRouting(ctx);
    await sleep(1200);
    await page.locator('[data-testid=lot]').first().click().catch(() => {});
    await until(() => visible(page, '[data-testid=lot-detail]'), 8000);
    await page.locator('[data-testid=navigate]').first().click().catch(() => {});
    check('W22 算路服务器连不上时出现 route-error 提示', !!await until(() => visible(page, '[data-testid=route-error]'), 30000));
    await unblockRouting(ctx);
  }
  await ctx.close();
  return log;
}

// ───── 搜索 + 定位被拒 ─────
async function searchAndDenied(browser, base) {
  const log = { pageErrors: [], route: [], foreignRoute: [], nominatim: [] };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  const page = await ctx.newPage(); instrument(page, log);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  if (!await waitReady(page, 'S1 无定位权限')) { await ctx.close(); return log; }
  await page.click('[data-testid=locate]');
  const err = await until(() => visible(page, '[data-testid=geo-error]'), 10000);
  const errText = err ? await page.locator('[data-testid=geo-error]').first().innerText() : '';
  check('S2 定位被拒：出现中文提示', !!err && (errText.match(CJK) || []).length >= 2, `"${errText}"`);
  const n0 = log.nominatim.length;
  await page.locator('[data-testid=search]').first().click();
  await page.keyboard.type('SM Megamall', { delay: 90 });
  const sug = await until(async () => (await page.locator('[data-testid=suggestion]').count()) > 0, 12000);
  if (!sug) await page.keyboard.press('Enter');
  const sug2 = sug || await until(async () => (await page.locator('[data-testid=suggestion]').count()) > 0, 12000);
  check('S3 搜 "SM Megamall" 出现候选', !!sug2);
  check('S4 打字过程不逐键请求 Nominatim（≤ 2 次，服务条款禁止自动补全）', log.nominatim.length - n0 <= 2, `nominatim=${log.nominatim.length - n0}`);
  if (sug2) {
    await page.locator('[data-testid=suggestion]').first().click();
    const L = await until(async () => { const x = await lots(page); return x.length >= 5 && hav(MEGAMALL.lat, MEGAMALL.lng, x[0].lat, x[0].lng) <= 1200 ? x : null; }, 15000);
    const ok = !!L && L.every((x, i) => i === 0 || x.d >= L[i - 1].d) && Math.abs(L[0].d - hav(MEGAMALL.lat, MEGAMALL.lng, L[0].lat, L[0].lng)) <= Math.max(150, 0.25 * L[0].d);
    check('S5 选中候选后列表改为该地点附近（首个 ≤1200m，按距离升序）', ok, L ? `nearest=${Math.round(L[0].d)}m` : 'no list');
  }
  await ctx.close();
  return log;
}

// ───── 手机：390×844 ─────
async function mobile(browser, base) {
  const log = { pageErrors: [], route: [], foreignRoute: [], nominatim: [] };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, geolocation: MAKATI, permissions: ['geolocation'], locale: 'zh-CN' });
  if (PROVE) await blockRouting(ctx);
  const page = await ctx.newPage(); instrument(page, log);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  if (!await waitReady(page, 'M1 手机')) { await ctx.close(); return log; }
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const sizes = async () => page.evaluate(() => [...document.querySelectorAll('[data-testid=locate],[data-testid=lang],[data-testid=mode-car],[data-testid=mode-moto],[data-testid=navigate],[data-testid=nav-stop],[data-testid=handoff-google],[data-testid=handoff-waze],[data-testid=search]')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })
    .map(e => { const r = e.getBoundingClientRect(); return { id: e.dataset.testid, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(s => s.w < 40 || s.h < 40));
  const share0 = await mapShare(page);
  check('M2 首屏地图可见面积 ≥ 50%', share0 >= 0.5, `${Math.round(share0 * 100)}%`);
  check('M3 首屏无横向滚动', (await overflow()) <= 0);
  let small = await sizes();
  check('M4 首屏按钮/输入框点击区域 ≥ 40×40', small.length === 0, JSON.stringify(small));
  await page.screenshot({ path: shotName('mobile-home.png') });

  await page.locator('[data-testid=locate]').first().tap();
  const L = await until(async () => { const x = await lots(page); return x.length >= 5 ? x : null; }, 20000);
  const inView = await page.evaluate(() => [...document.querySelectorAll('[data-testid=lot]')].some(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.width > 0; }));
  check('M5 定位后至少一个列表项完整出现在屏幕内', !!L && inView);
  if (L) {
    await page.locator('[data-testid=lot]').first().tap();
    await until(() => visible(page, '[data-testid=lot-detail]'), 8000);
    small = await sizes();
    check('M6 详情页无横向滚动，按钮点击区域 ≥ 40×40', (await overflow()) <= 0 && small.length === 0, JSON.stringify(small));
    await page.screenshot({ path: shotName('mobile-detail.png') });
    await page.locator('[data-testid=navigate]').first().tap();
    const panel = await until(async () => (await visible(page, '[data-testid=nav-panel]')) && (await routeCoords(page) || []).length >= 10, 25000);
    check('M7 手机开始导航：路线画出、导航面板可见', !!panel);
    if (panel) {
      await sleep(2000);
      const share = await mapShare(page);
      small = await sizes();
      check('M8 导航中地图可见面积 ≥ 40%，无横向滚动，按钮 ≥ 40×40', share >= 0.4 && (await overflow()) <= 0 && small.length === 0, `map=${Math.round(share * 100)}% small=${JSON.stringify(small)}`);
      await page.screenshot({ path: shotName('mobile-nav.png') });
    }
  }
  await ctx.close();
  return log;
}

// ───── 主流程 ─────
let srv = null, base = urlArg;
if (!base) { srv = await startServer(); base = `http://127.0.0.1:${srv.address().port}/`; }
fs.mkdirSync(SHOT, { recursive: true });
console.log(`ParkingPH 验收  base=${base}${PROVE ? '  [--prove：算路服务器已屏蔽]' : ''}`);
if (!urlArg && !fs.existsSync(path.join(ROOT, 'index.html'))) check('P0 index.html 存在', false);
await checkData(base);
const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const logs = [];
for (const run of [desktop, searchAndDenied, mobile]) {
  try { logs.push(await run(browser, base)); } catch (e) { check(`${run.name} 流程异常中断`, false, String(e.message || e).split('\n')[0]); }
}
await browser.close();
if (srv) srv.close();

const all = { pageErrors: logs.flatMap(l => l.pageErrors), route: logs.map(l => l.route), foreign: logs.flatMap(l => l.foreignRoute) };
check('G1 全程无未捕获 JS 异常', all.pageErrors.length === 0, all.pageErrors.slice(0, 3).join(' | '));
let minGap = Infinity;
for (const r of all.route) for (const h of ROUTE_HOSTS) {
  const t = r.filter(x => new URL(x.url).hostname === h).map(x => x.t);
  for (let i = 1; i < t.length; i++) minGap = Math.min(minGap, t[i] - t[i - 1]);
}
check('G2 同一算路服务器两次请求间隔 ≥ 900ms', minGap >= 900, `minGap=${minGap === Infinity ? '-' : minGap + 'ms'}`);
check('G3 没有请求白名单以外的算路服务', all.foreign.length === 0, all.foreign.slice(0, 3).join(' | '));

console.log(`\n${results.length - fails}/${results.length} PASS${fails ? `，${fails} FAIL` : ''}`);
process.exit(fails ? 1 : 0);
