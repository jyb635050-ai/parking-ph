"""大马尼拉（NCR）停车场交叉验证：给每个 OSM 停车场收集多路证据，输出 tools/cache/ncr-evidence.json。

证据来源（互相独立程度从低到高）：
  tag   OSM 标签：收费 / 收费细则 / 运营方 / 停车楼类型
  geom  OSM 几何：是面（有轮廓）且面积够大，或是停车楼建筑
  ent   OSM 停车场入口节点（parking_entrance）落在旁边
  poi   OSM 周边有会收停车费的地标（商场、医院、机场、写字楼、酒店、大学、车站）
  wd    Wikidata（独立数据库）里有同类地标在旁边
  sat   卫星图人工目检结果（tools/ncr_satellite_review.json，由目检步骤写入）
用法：python tools/ncr_evidence.py
"""
import json, math, re, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
geom = json.load(open(os.path.join(CACHE, 'ncr-geom.json'), encoding='utf-8'))
ctx = json.load(open(os.path.join(CACHE, 'ncr-raw.json'), encoding='utf-8'))
wd = json.load(open(os.path.join(CACHE, 'wd-ncr.json'), encoding='utf-8'))['results']['bindings']
review_path = os.path.join(HERE, 'ncr_satellite_review.json')
review = json.load(open(review_path, encoding='utf-8')) if os.path.exists(review_path) else {}

R = 6371008.8
def hav(a, b, c, d):
    r = math.pi / 180
    s = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 2 * R * math.asin(math.sqrt(s))

def ring_area(pts):  # pts: [(lat,lon)]，局部平面近似，m²
    if len(pts) < 3: return 0.0
    lat0 = sum(p[0] for p in pts) / len(pts)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i][1] * kx, pts[i][0] * ky
        x2, y2 = pts[(i + 1) % len(pts)][1] * kx, pts[(i + 1) % len(pts)][0] * ky
        s += x1 * y2 - x2 * y1
    return abs(s) / 2

def shape(e):
    """返回 (中心 lat, lon, 面积 m², 轮廓点列表)"""
    if e['type'] == 'node':
        return e['lat'], e['lon'], 0.0, []
    rings = []
    if e['type'] == 'way' and e.get('geometry'):
        rings = [[(p['lat'], p['lon']) for p in e['geometry']]]
    elif e['type'] == 'relation':
        rings = [[(p['lat'], p['lon']) for p in m['geometry']] for m in e.get('members', []) if m.get('role') == 'outer' and m.get('geometry')]
    pts = [p for r in rings for p in r]
    if not pts:
        b = e.get('bounds')
        return ((b['minlat'] + b['maxlat']) / 2, (b['minlon'] + b['maxlon']) / 2, 0.0, []) if b else (None, None, 0, [])
    area = sum(ring_area(r) for r in rings)
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), area, rings[0]

STRUCT = {'multi-storey', 'underground', 'rooftop'}
def generator_kind(t):
    if t.get('shop') in ('mall', 'department_store'): return 'mall'
    if t.get('shop') == 'supermarket' and t.get('name'): return 'supermarket'
    if t.get('amenity') == 'hospital': return 'hospital'
    if t.get('aeroway') == 'terminal': return 'airport'
    if t.get('amenity') in ('university', 'college'): return 'school'
    if t.get('railway') == 'station': return 'station'
    if t.get('tourism') == 'hotel' or t.get('building') == 'hotel': return 'hotel'
    if t.get('building') in ('office', 'commercial', 'retail') and t.get('name'): return 'office'
    if t.get('amenity') == 'marketplace': return 'market'
    return None

gens, entrances = [], []
for e in ctx['elements']:
    t = e.get('tags', {})
    lat = e.get('lat') or (e.get('center') or {}).get('lat')
    lon = e.get('lon') or (e.get('center') or {}).get('lon')
    if lat is None: continue
    if t.get('amenity') == 'parking_entrance':
        entrances.append((lat, lon, t.get('access')))
        continue
    k = generator_kind(t)
    if k: gens.append((lat, lon, k, t.get('name', '')))

WD_KIND = {'Q31374404': 'mall', 'Q11315': 'mall', 'Q16917': 'hospital', 'Q1248784': 'airport', 'Q11303': 'office', 'Q1021645': 'office',
           'Q27686': 'hotel', 'Q3918': 'school', 'Q928830': 'station', 'Q55488': 'station', 'Q1076486': 'venue', 'Q483110': 'venue', 'Q18674739': 'venue'}
wds = []
for b in wd:
    m = re.match(r'Point\(([-\d.]+) ([-\d.]+)\)', b['c']['value'])
    if m:
        wds.append((float(m.group(2)), float(m.group(1)), WD_KIND[b['type']['value'].split('/')[-1]], b.get('l', {}).get('value', '')))

def nearest(lat, lon, items, maxd):
    best = None
    for it in items:
        if abs(it[0] - lat) > 0.01 or abs(it[1] - lon) > 0.01: continue
        d = hav(lat, lon, it[0], it[1])
        if d <= maxd and (best is None or d < best[0]): best = (d, it)
    return best

out = []
for e in geom['elements']:
    t = e.get('tags', {})
    if t.get('amenity') not in ('parking', 'motorcycle_parking') and t.get('building') != 'parking': continue
    lat, lon, area, ring = shape(e)
    if lat is None: continue
    oid = e['type'][0] + str(e['id'])
    reach = max(120, math.sqrt(area) * 0.8 + 60)
    ev = {}
    fee = (t.get('fee') or '').strip().lower()
    if fee and fee != 'no': ev['tag_fee'] = t['fee']
    if t.get('charge'): ev['tag_charge'] = t['charge']
    if t.get('operator'): ev['tag_operator'] = t['operator']
    # building=parking 只有在没被标成车棚/露天等时才算停车楼
    is_struct = t.get('parking') in STRUCT or (t.get('building') == 'parking' and not t.get('parking'))
    if is_struct: ev['tag_struct'] = t.get('parking') or 'building=parking'
    if area >= 800 or is_struct: ev['geom'] = round(area)
    ent = nearest(lat, lon, entrances, max(60, math.sqrt(area) * 0.7 + 30))
    if ent: ev['ent'] = round(ent[0])
    g = nearest(lat, lon, gens, reach)
    if g: ev['poi'] = f"{g[1][2]}:{g[1][3]}@{round(g[0])}m"
    w = nearest(lat, lon, [x for x in wds if x[2] != 'hotel'], reach + 150) or nearest(lat, lon, [x for x in wds if x[2] == 'hotel'], reach)
    if w: ev['wd'] = f"{w[1][2]}:{w[1][3]}@{round(w[0])}m"
    rv = review.get(oid)
    if rv: ev['sat'] = rv
    out.append({
        'id': oid, 'kind': 'moto' if t.get('amenity') == 'motorcycle_parking' else 'car',
        'lat': round(lat, 6), 'lon': round(lon, 6), 'area': round(area), 'ring': [[round(p[0], 6), round(p[1], 6)] for p in ring],
        'name': t.get('name'), 'access': t.get('access'), 'fee': t.get('fee'), 'parking': t.get('parking'), 'operator': t.get('operator'),
        'version': e.get('version'), 'timestamp': e.get('timestamp'), 'ev': ev,
        'tags': {k: t[k] for k in ('name:en', 'charge', 'capacity', 'opening_hours', 'covered', 'supervised') if k in t},
    })

# ── 收录裁决（领导 2026-09-17：大马尼拉多找、交叉验证是否真实）──
# A 有标签+独立旁证：停车楼类免目检；其余卫星图不能是「不是停车场」
# B 只有标签：卫星图必须是停车场或停车楼
# C 无标签、面积≥800㎡、紧挨商场/医院/写字楼/酒店/车站/机场或有入口：卫星图必须是停车场；
#   是停车楼时还要有入口节点或紧挨商场/机场/医院/写字楼
# D 无标签、只挨着学校/市场：卫星图必须是停车场
NAMED = re.compile(r'car ?park|parking|parkade', re.I)
PAYGEN = {'mall', 'supermarket', 'hospital', 'airport', 'office', 'hotel', 'station', 'venue'}
BIG = {'mall', 'airport', 'hospital', 'office'}
LABEL = {'mall': '商场', 'supermarket': '超市', 'hospital': '医院', 'airport': '机场', 'office': '写字楼', 'hotel': '酒店',
         'station': '车站', 'venue': '场馆', 'school': '学校', 'market': '市场'}
def place(s):
    k, rest = s.split(':', 1)
    name, d = rest.rsplit('@', 1)
    return k, (f"{LABEL.get(k, k)} {name}".strip() + f"（{d}）")
for it in out:
    e = it['ev']
    it['decision'] = None
    if it['access'] in ('private', 'no') or (it['fee'] or '').lower() == 'no':
        continue
    tagged = any(k.startswith('tag_') for k in e)
    ind = any(k in e for k in ('poi', 'wd', 'ent'))
    kinds = {place(e[k])[0] for k in ('poi', 'wd') if k in e}
    sat = e.get('sat')
    if tagged and ind:
        ok = 'tag_struct' in e or sat != 'not_parking'
    elif tagged:
        ok = sat in ('lot', 'structure')
    elif 'geom' in e and (kinds & PAYGEN or 'ent' in e):
        ok = sat == 'lot' or (sat == 'structure' and ('ent' in e or kinds & BIG))
        # 或：地图上有停车场专用入口，且周边地标/Wikidata 佐证（如 Ayala Center 的 Park Square）
        if not ok and sat != 'not_parking':
            support = sum(['ent' in e, 'poi' in e and place(e['poi'])[0] in PAYGEN, 'wd' in e])
            ok = support >= 2 and 'ent' in e   # 必须有停车场专用入口（有管理的出入口）
    elif 'geom' in e and ind:
        ok = sat == 'lot'
    else:
        ok = False
    if not ok:
        continue
    why = []
    if 'tag_fee' in e or 'tag_charge' in e: why.append('OSM 标了收费')
    if 'tag_operator' in e: why.append(f"运营方 {e['tag_operator']}")
    if 'tag_struct' in e: why.append('停车楼')
    if 'ent' in e: why.append('有停车场入口')
    if 'poi' in e: why.append('紧邻' + place(e['poi'])[1])
    if 'wd' in e: why.append('Wikidata：' + place(e['wd'])[1])
    if sat == 'lot': why.append('卫星图可见车位')
    elif sat == 'structure': why.append('卫星图为停车楼/大楼')
    it['decision'] = {'v': 'sat' if sat in ('lot', 'structure') else 'multi', 'why': why, 'group': 'A' if tagged and ind else 'B' if tagged else 'C'}

print('收录', sum(1 for it in out if it['decision']), '其中卫星核实', sum(1 for it in out if it['decision'] and it['decision']['v'] == 'sat'))
json.dump({'osm_base': geom['osm3s']['timestamp_osm_base'], 'items': out}, open(os.path.join(CACHE, 'ncr-evidence.json'), 'w', encoding='utf-8'), ensure_ascii=False)

# ── 汇总 ──
c = collections.Counter()
for it in out:
    ev, t = it['ev'], it
    if t['access'] in ('private', 'no'): c['私人'] += 1; continue
    if (t['fee'] or '').lower() == 'no': c['明确免费'] += 1; continue
    tagged = any(k.startswith('tag_') for k in ev)
    ctxs = [k for k in ('geom', 'ent', 'poi', 'wd') if k in ev]
    c['全部可用'] += 1
    if tagged: c['现口径(有标签)'] += 1
    if tagged and len(ctxs) >= 1: c['现口径+≥1旁证'] += 1
    if tagged and not ctxs: c['现口径但无旁证'] += 1
    if not tagged and 'geom' in ev and ('poi' in ev or 'wd' in ev or 'ent' in ev): c['新候选(大面+地标/入口)'] += 1
print(json.dumps(c, ensure_ascii=False, indent=1))
