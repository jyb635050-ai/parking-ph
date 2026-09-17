// 把需要目检的大马尼拉停车场渲染成卫星图拼图（Esri World Imagery），红框=OSM 轮廓，黄点=节点位置
//   node tools/ncr_sheets.mjs   → shots/sat/sheet-NN.png + tools/cache/sat-index.json
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire('C:/Users/73405/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const PAYGEN = new Set(['mall', 'supermarket', 'hospital', 'airport', 'office', 'hotel', 'station', 'venue']);
const ev = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/cache/ncr-evidence.json'), 'utf8'));
const todo = [], sampleA = [];
for (const it of ev.items) {
  const e = it.ev;
  if (['private', 'no'].includes(it.access) || (it.fee || '').toLowerCase() === 'no') continue;
  const tagged = Object.keys(e).some(k => k.startsWith('tag_'));
  const ind = ['poi', 'wd', 'ent'].some(k => k in e);
  const kinds = [(e.poi || '').split(':')[0], (e.wd || '').split(':')[0]];
  const paygen = kinds.some(k => PAYGEN.has(k)) || 'ent' in e;
  let group = null;
  if (tagged && !ind) group = 'B';
  else if (!tagged && e.geom != null && paygen) group = 'C';
  else if (!tagged && e.geom != null && ind) group = 'D';
  if (group) todo.push({ ...it, group });
  else if (tagged && ind) sampleA.push({ ...it, group: 'A' });
}
// REVIEW_A=1：「有标签＋旁证」组里除停车楼外、尚未目检的全部，输出 sheet-r-NN.png
if (process.env.REVIEW_A) {
  const done = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/ncr_satellite_review.json'), 'utf8'));
  todo.length = 0;
  for (const it of sampleA) if (!('tag_struct' in it.ev) && !(it.id in done)) todo.push(it);
}
// ONLY=id1,id2：只渲染指定条目（复查用），输出 sheet-o-NN.png
if (process.env.ONLY) {
  const want = new Set(process.env.ONLY.split(','));
  todo.length = 0;
  for (const it of ev.items) if (want.has(it.id)) todo.push({ ...it, group: 'O' });
}
// SAMPLE_A=n：从「有标签＋独立旁证」组里按固定种子抽 n 个做抽检，输出 sheet-a-NN.png
if (process.env.SAMPLE_A) {
  let seed = 20260917;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pool = sampleA.slice();
  todo.length = 0;
  while (todo.length < +process.env.SAMPLE_A && pool.length) todo.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
}

const COLS = 6, CELL = 256, PER = 30;
const TILE = 256;
const project = (lat, lon, z) => {
  const n = 2 ** z, s = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * n * TILE, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * TILE];
};
const hosts = ['server', 'services', 'server2'];

function cellHtml(it, idx) {
  const pts = it.ring.length ? it.ring : [[it.lat, it.lon]];
  const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
  const ext = Math.max(40, (Math.max(...lats) - Math.min(...lats)) * 110540, (Math.max(...lons) - Math.min(...lons)) * 111320 * Math.cos(it.lat * Math.PI / 180));
  const mpp = 156543.03 * Math.cos(it.lat * Math.PI / 180);
  const z = Math.max(15, Math.min(19, Math.floor(Math.log2(mpp * 190 / ext))));
  const [cx, cy] = project(it.lat, it.lon, z);
  const x0 = cx - CELL / 2, y0 = cy - CELL / 2;
  let imgs = '';
  for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + CELL) / TILE); tx++) {
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + CELL) / TILE); ty++) {
      const h = hosts[(tx + ty) % 3];
      imgs += `<img src="https://${h}.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}" style="left:${tx * TILE - x0}px;top:${ty * TILE - y0}px">`;
    }
  }
  const poly = it.ring.length
    ? `<polygon points="${it.ring.map(p => project(p[0], p[1], z)).map(([x, y]) => `${(x - x0).toFixed(1)},${(y - y0).toFixed(1)}`).join(' ')}" fill="none" stroke="#ff2a2a" stroke-width="2"/>`
    : `<circle cx="${CELL / 2}" cy="${CELL / 2}" r="6" fill="none" stroke="#ffe600" stroke-width="3"/>`;
  const scale = Math.round(mpp / 2 ** z * 50);
  return `<div class="c"><div class="m">${imgs}</div><svg width="${CELL}" height="${CELL}">${poly}</svg>
    <b>${idx}</b><i>${it.group} z${z} · 50px≈${scale}m</i></div>`;
}

fs.mkdirSync(path.join(ROOT, 'shots/sat'), { recursive: true });
const index = {};
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const page = await browser.newPage({ viewport: { width: COLS * CELL + (COLS - 1) * 4, height: 900 } });
for (let s = 0; s * PER < todo.length; s++) {
  const chunk = todo.slice(s * PER, (s + 1) * PER);
  const cells = chunk.map((it, k) => { const idx = s * PER + k; index[idx] = it.id; return cellHtml(it, idx); }).join('');
  const html = `<!doctype html><style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${COLS},${CELL}px);gap:4px;font:bold 15px sans-serif}
    .c{position:relative;width:${CELL}px;height:${CELL}px;overflow:hidden}.m img{position:absolute;width:${TILE}px;height:${TILE}px}
    svg{position:absolute;left:0;top:0}b{position:absolute;left:3px;top:2px;color:#fff;background:#000c;padding:0 4px}
    i{position:absolute;right:3px;bottom:2px;color:#fff;background:#000a;font:11px sans-serif;padding:0 3px}</style>${cells}`;
  await page.setContent(html, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate(() => Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
  const file = path.join(ROOT, `shots/sat/sheet-${process.env.SAMPLE_A ? 'a-' : process.env.REVIEW_A ? 'r-' : process.env.ONLY ? 'o-' : ''}${String(s).padStart(2, '0')}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(file, chunk.length);
}
await browser.close();
fs.writeFileSync(path.join(ROOT, process.env.SAMPLE_A ? 'tools/cache/sat-index-a.json' : process.env.REVIEW_A ? 'tools/cache/sat-index-r.json' : process.env.ONLY ? 'tools/cache/sat-index-o.json' : 'tools/cache/sat-index.json'), JSON.stringify({ osm_base: ev.osm_base, count: todo.length, index }));
console.log('total', todo.length);
