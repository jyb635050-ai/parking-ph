// 算路（Valhalla 为主、OSRM 汽车备用）+ 路线几何工具
window.Routing = (() => {
  const VALHALLA = 'valhalla1.openstreetmap.de';
  const OSRM = 'router.project-osrm.org';
  const lastReq = {};

  // 服务条款：同一台服务器每秒最多 1 次
  const throttle = async host => {
    const wait = 1050 - (Date.now() - (lastReq[host] || 0));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastReq[host] = Date.now();
  };

  // Valhalla 的 shape 是精度 1e6 的 polyline
  function decodePolyline6(str) {
    const out = []; let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const which of [0, 1]) {
        let b, shift = 0, result = 0;
        do { b = str.charCodeAt(i++) - 63; result |= (b & 31) << shift; shift += 5; } while (b >= 32);
        const d = result & 1 ? ~(result >> 1) : result >> 1;
        if (which === 0) lat += d; else lng += d;
      }
      out.push([lng / 1e6, lat / 1e6]);
    }
    return out;
  }

  const VALHALLA_ACT = {
    1: 'depart', 2: 'depart', 3: 'depart', 4: 'arrive', 5: 'arrive', 6: 'arrive', 7: 'straight', 8: 'straight',
    9: 'slight-right', 10: 'right', 11: 'sharp-right', 12: 'uturn', 13: 'uturn', 14: 'sharp-left', 15: 'left', 16: 'slight-left',
    17: 'ramp', 18: 'ramp-right', 19: 'ramp-left', 20: 'exit-right', 21: 'exit-left', 22: 'keep-straight', 23: 'keep-right', 24: 'keep-left',
    25: 'merge', 26: 'roundabout', 27: 'roundabout-exit', 28: 'ferry', 29: 'ferry', 37: 'merge', 38: 'merge',
  };

  async function valhalla(from, to, mode, signal) {
    await throttle(VALHALLA);
    const body = {
      locations: [{ lat: from.lat, lon: from.lng, ...(Number.isFinite(from.heading) ? { heading: Math.round(from.heading), heading_tolerance: 60 } : {}) }, { lat: to.lat, lon: to.lng }],
      costing: mode === 'moto' ? 'motorcycle' : 'auto',
      directions_options: { units: 'kilometers', language: 'en-US' },
    };
    const res = await fetch(`https://${VALHALLA}/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`valhalla HTTP ${res.status}`);
    const j = await res.json();
    const leg = j?.trip?.legs?.[0];
    if (!leg?.shape) throw new Error('valhalla: no route');
    const coords = decodePolyline6(leg.shape);
    const steps = (leg.maneuvers || []).map(m => ({
      act: VALHALLA_ACT[m.type] || 'straight',
      begin: Math.min(m.begin_shape_index ?? 0, coords.length - 1),
      street: (m.street_names && m.street_names[0]) || (m.begin_street_names && m.begin_street_names[0]) || '',
      exit: m.roundabout_exit_count || 0,
      en: m.instruction || '',
    }));
    return finish({ coords, steps, duration: j.trip.summary.time, provider: 'valhalla', mode });
  }

  function osrmAct(type, mod) {
    if (type === 'depart') return 'depart';
    if (type === 'arrive') return 'arrive';
    if (type === 'roundabout' || type === 'rotary') return 'roundabout';
    if (type === 'exit roundabout' || type === 'exit rotary') return 'roundabout-exit';
    if (type === 'on ramp') return mod?.includes('right') ? 'ramp-right' : mod?.includes('left') ? 'ramp-left' : 'ramp';
    if (type === 'off ramp') return mod?.includes('left') ? 'exit-left' : 'exit-right';
    if (type === 'fork') return mod?.includes('right') ? 'keep-right' : mod?.includes('left') ? 'keep-left' : 'keep-straight';
    if (type === 'merge') return 'merge';
    return { uturn: 'uturn', 'sharp right': 'sharp-right', right: 'right', 'slight right': 'slight-right', straight: 'straight', 'slight left': 'slight-left', left: 'left', 'sharp left': 'sharp-left' }[mod] || 'straight';
  }

  async function osrm(from, to, mode, signal) {
    await throttle(OSRM);
    const url = `https://${OSRM}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`osrm HTTP ${res.status}`);
    const j = await res.json();
    const r = j?.routes?.[0];
    if (j.code !== 'Ok' || !r) throw new Error('osrm: no route');
    const coords = r.geometry.coordinates;
    let cursor = 0;
    const steps = [];
    for (const s of r.legs[0].steps) {
      const [x, y] = s.maneuver.location;
      let best = cursor, bd = Infinity;
      for (let i = cursor; i < coords.length; i++) {
        const d = (coords[i][0] - x) ** 2 + (coords[i][1] - y) ** 2;
        if (d < bd) { bd = d; best = i; }
        if (d === 0) break;
      }
      cursor = best;
      steps.push({ act: osrmAct(s.maneuver.type, s.maneuver.modifier), begin: best, street: s.name || '', exit: s.maneuver.exit || 0, en: '' });
    }
    return finish({ coords, steps, duration: r.duration, provider: 'osrm', mode });
  }

  // 累计里程，供投影与剩余距离计算
  function finish(route) {
    const cum = [0];
    for (let i = 1; i < route.coords.length; i++) cum.push(cum[i - 1] + haversine(route.coords[i - 1][1], route.coords[i - 1][0], route.coords[i][1], route.coords[i][0]));
    route.cum = cum;
    route.distance = cum[cum.length - 1];
    return route;
  }

  // 先 Valhalla（汽车/摩托），失败换 OSRM（只有汽车规则；摩托车模式降级时如实标出）
  async function plan(from, to, mode, signal) {
    try {
      return await valhalla(from, to, mode, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      const r = await osrm(from, to, mode, signal);
      r.degraded = mode === 'moto';
      return r;
    }
  }

  function haversine(aLat, aLng, bLat, bLng) {
    const R = 6371008.8, rad = Math.PI / 180;
    const s = Math.sin((bLat - aLat) * rad / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin((bLng - aLng) * rad / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // 把位置投影到路线上：离路线多远、沿路线走了多远、在哪一段
  function project(route, lat, lng) {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    const c = route.coords;
    let best = { dist: Infinity, seg: 0, along: 0 };
    for (let i = 0; i < c.length - 1; i++) {
      const ax = (c[i][0] - lng) * kx, ay = (c[i][1] - lat) * ky;
      const bx = (c[i + 1][0] - lng) * kx, by = (c[i + 1][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let tt = len2 ? -(ax * dx + ay * dy) / len2 : 0;
      tt = Math.max(0, Math.min(1, tt));
      const px = ax + tt * dx, py = ay + tt * dy;
      const d = Math.hypot(px, py);
      if (d < best.dist) best = { dist: d, seg: i, along: route.cum[i] + tt * (route.cum[i + 1] - route.cum[i]) };
    }
    if (c.length === 1) best = { dist: haversine(lat, lng, c[0][1], c[0][0]), seg: 0, along: 0 };
    return best;
  }

  function bearingAt(route, seg) {
    const c = route.coords, a = c[Math.min(seg, c.length - 2)], b = c[Math.min(seg + 1, c.length - 1)];
    if (!a || !b) return 0;
    const y = Math.sin((b[0] - a[0]) * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180);
    const x = Math.cos(a[1] * Math.PI / 180) * Math.sin(b[1] * Math.PI / 180) - Math.sin(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.cos((b[0] - a[0]) * Math.PI / 180);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  return { plan, project, bearingAt, haversine, decodePolyline6, hosts: [VALHALLA, OSRM] };
})();
