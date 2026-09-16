// 抓取全菲律宾 OSM 停车场 → data/parking.json
//   node tools/build_data.mjs            有缓存就用缓存（tools/cache/overpass-raw.json）
//   node tools/build_data.mjs --refresh  重新向 Overpass 查询（三个镜像轮流重试），成功才覆盖缓存
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools/cache/overpass-raw.json');
const OUT = path.join(ROOT, 'data/parking.json');
const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const QUERY = '[out:json][timeout:600][maxsize:536870912];area["ISO3166-1"="PH"][admin_level=2]->.ph;(nwr["amenity"~"^(parking|motorcycle_parking)$"](area.ph););out center tags;';

async function fetchOverpass() {
  for (let round = 1; round <= 2; round++) {
    for (const url of MIRRORS) {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ParkingPH-data/1.0 (github.com/jyb635050-ai/parking-ph)', Accept: '*/*' },
          body: 'data=' + encodeURIComponent(QUERY),
          signal: AbortSignal.timeout(650_000),
        });
        const text = await res.text();
        console.log(`${url} → HTTP ${res.status} ${text.length}B ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        if (res.ok && text.trimStart().startsWith('{')) {
          const json = JSON.parse(text);
          if (Array.isArray(json.elements) && json.elements.length > 10000) return text;
        }
      } catch (e) {
        console.log(`${url} → ${e.name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 15_000));
    }
  }
  return null;
}

let raw;
if (process.argv.includes('--refresh') || !fs.existsSync(CACHE)) {
  raw = await fetchOverpass();
  // 镜像之间数据新旧不一（实测 kumi 同一天先后返回 06-01 与 05-06 两个版本），只接受比缓存更新的
  const base = t => { try { return JSON.parse(t).osm3s?.timestamp_osm_base || ''; } catch { return ''; } };
  if (raw && fs.existsSync(CACHE) && base(raw) <= base(fs.readFileSync(CACHE, 'utf8'))) {
    console.log(`新结果 ${base(raw)} 不比缓存 ${base(fs.readFileSync(CACHE, 'utf8'))} 新，保留缓存`);
    raw = null;
  } else if (raw) { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, raw); }
  else if (fs.existsSync(CACHE)) console.log('沿用缓存');
  else { console.error('所有镜像都失败且没有缓存'); process.exit(1); }
}
raw = raw || fs.readFileSync(CACHE, 'utf8');
const src = JSON.parse(raw);

const clean = v => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : undefined; };
const EXCLUDED_ACCESS = new Set(['private', 'no']);
const features = [];
let skippedAccess = 0, skippedGeom = 0;
for (const e of src.elements) {
  const t = e.tags || {};
  if (EXCLUDED_ACCESS.has(t.access)) { skippedAccess++; continue; }
  const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { skippedGeom++; continue; }
  const p = {
    id: `${e.type[0]}${e.id}`,
    kind: t.amenity === 'motorcycle_parking' ? 'moto' : 'car',
    name: clean(t.name) || clean(t['name:en']) || null,
    t: clean(t.parking),                       // surface / multi-storey / underground / street_side …
    fee: clean(t.fee),                         // yes / no / 自由文本
    cap: num(t.capacity),
    acc: clean(t.access),                      // customers / yes / permissive …
    oh: clean(t.opening_hours),
    op: clean(t.operator),
    cov: clean(t.covered),
    sup: clean(t.supervised),
  };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [+lon.toFixed(6), +lat.toFixed(6)] }, properties: p });
}

const out = {
  type: 'FeatureCollection',
  meta: {
    source: 'OpenStreetMap contributors, ODbL 1.0',
    osm_base: src.osm3s?.timestamp_osm_base || null,
    built_at: new Date().toISOString(),
    excluded_access_private_or_no: skippedAccess,
  },
  features,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const car = features.filter(f => f.properties.kind === 'car').length;
console.log(`写出 ${features.length} 条（汽车 ${car}／摩托 ${features.length - car}），剔除 access=private/no ${skippedAccess}，无坐标 ${skippedGeom}；OSM 时间 ${out.meta.osm_base}；${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB`);
