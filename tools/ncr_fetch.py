"""下载大马尼拉交叉验证用的原始数据到 tools/cache/（查询与 2026-09-17 实际使用的一致）。
用法：python tools/ncr_fetch.py      之后依次：python tools/ncr_evidence.py → node tools/build_data.mjs
卫星图目检结论在 tools/ncr_satellite_review.json（人工逐张看 node tools/ncr_sheets.mjs 生成的拼图得出）。
"""
import os, time, urllib.parse, urllib.request

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
UA = {'User-Agent': 'ParkingPH-data/1.0 (github.com/jyb635050-ai/parking-ph)'}
MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']

CONTEXT = ('[out:json][timeout:300];area["ISO3166-2"="PH-00"]->.a;('
           'nwr["amenity"~"^(parking|motorcycle_parking|parking_entrance)$"](area.a);nwr["building"="parking"](area.a);'
           'nwr["parking"~"^(multi-storey|underground|rooftop)$"](area.a);nwr["shop"~"^(mall|department_store|supermarket)$"](area.a);'
           'nwr["amenity"~"^(hospital|university|college|marketplace|place_of_worship)$"](area.a);nwr["aeroway"="terminal"](area.a);'
           'nwr["railway"="station"](area.a);nwr["building"~"^(office|commercial|retail|hotel)$"]["name"](area.a);nwr["tourism"="hotel"](area.a););'
           'out center tags meta;')
GEOM = ('[out:json][timeout:300];area["ISO3166-2"="PH-00"]->.a;(nwr["amenity"~"^(parking|motorcycle_parking)$"](area.a);'
        'nwr["building"="parking"](area.a););out geom tags meta;')
WIKIDATA = ('SELECT DISTINCT ?i ?l ?c ?type WHERE { SERVICE wikibase:box { ?i wdt:P625 ?c. '
            'bd:serviceParam wikibase:cornerSouthWest "Point(120.90 14.34)"^^geo:wktLiteral. '
            'bd:serviceParam wikibase:cornerNorthEast "Point(121.14 14.79)"^^geo:wktLiteral. } '
            'VALUES ?type {wd:Q31374404 wd:Q11315 wd:Q16917 wd:Q1248784 wd:Q11303 wd:Q1021645 wd:Q27686 wd:Q3918 wd:Q928830 wd:Q55488 wd:Q1076486 wd:Q483110 wd:Q18674739} '
            '?i wdt:P31 ?type. OPTIONAL { ?i rdfs:label ?l FILTER(lang(?l)="en") } }')

def get(url, data=None, headers=None, timeout=330):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def overpass(q, name):
    for rnd in range(2):
        for ep in MIRRORS:
            try:
                body = get(ep, urllib.parse.urlencode({'data': q}).encode())
                if body.lstrip().startswith(b'{'):
                    open(os.path.join(CACHE, name), 'wb').write(body)
                    print(name, 'OK', ep, len(body))
                    return
                print(name, ep, 'non-JSON', len(body))
            except Exception as ex:
                print(name, ep, ex)
            time.sleep(15)
    raise SystemExit(f'{name}: all mirrors failed')

os.makedirs(CACHE, exist_ok=True)
overpass(CONTEXT, 'ncr-raw.json')
overpass(GEOM, 'ncr-geom.json')
open(os.path.join(CACHE, 'wd-ncr.json'), 'wb').write(get('https://query.wikidata.org/sparql?' + urllib.parse.urlencode({'query': WIKIDATA}), headers={'Accept': 'application/sparql-results+json'}))
print('wd-ncr.json OK')
open(os.path.join(CACHE, 'ncr-boundary.geojson'), 'wb').write(get('https://nominatim.openstreetmap.org/search?q=Metro+Manila&countrycodes=ph&format=geojson&polygon_geojson=1&polygon_threshold=0.0005&limit=1'))
print('ncr-boundary.geojson OK')
