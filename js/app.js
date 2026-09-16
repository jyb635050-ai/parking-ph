/* 泊车雷达 ParkingPH —— 地图、附近列表、搜索、导航 */
(() => {
  const { t } = I18N;
  const $ = id => document.getElementById(id);
  const hav = Routing.haversine;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const isMobile = () => matchMedia('(max-width: 819px)').matches;

  const S = {
    mode: 'car',
    data: null, lat: null, lng: null,     // 停车场坐标数组，算附近用
    fix: null, fixAt: 0, watchId: null, geoWaiters: [], geoDenied: false,
    ref: null,                            // 附近列表的参考点 {lat,lng,label,kind:'me'|'place'}
    lots: [],                             // 当前列表
    selected: null,                       // 选中的 feature 下标
    nav: null,
    muted: false,
  };

  /* ───────── 地图 ───────── */
  const PH_BOUNDS = [[114.0, 3.2], [129.5, 22.2]];
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/dark',
    center: [122.3, 12.2],
    zoom: isMobile() ? 4.6 : 5.4,
    minZoom: 4,
    maxBounds: PH_BOUNDS,
    attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors' },
    dragRotate: true,
    pitchWithRotate: true,
  });
  window.__map = map;
  if (!isMobile()) map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

  const dataPromise = fetch('data/parking.json').then(r => {
    if (!r.ok) throw new Error(`data HTTP ${r.status}`);
    return r.json();
  });

  const empty = () => ({ type: 'FeatureCollection', features: [] });
  const pointFC = (lng, lat, props = {}) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props }] });

  function tintBasemap() {
    for (const layer of map.getStyle().layers) {
      try {
        if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#030a12');
        else if (layer.type === 'fill' && /water/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#06192b');
        else if (layer.type === 'line' && /^(highway|road|tunnel|bridge)/.test(layer.id) && !/casing/.test(layer.id)) map.setPaintProperty(layer.id, 'line-color', '#1c3a50');
      } catch { /* 部分图层属性是表达式或不存在，跳过 */ }
    }
  }

  map.on('load', async () => {
    tintBasemap();
    let data;
    try { data = await dataPromise; } catch (e) { toast('route-error', t('noLots')); console.error(e); return; }
    S.data = data;
    const n = data.features.length;
    S.lat = new Float64Array(n); S.lng = new Float64Array(n);
    data.features.forEach((f, i) => { S.lng[i] = f.geometry.coordinates[0]; S.lat[i] = f.geometry.coordinates[1]; });
    $('data-date').textContent = (data.meta?.osm_base || '').slice(0, 10) || '—';

    map.addSource('lots', { type: 'geojson', data, promoteId: 'id' });
    map.addSource('route', { type: 'geojson', data: empty(), lineMetrics: true });
    map.addSource('me', { type: 'geojson', data: empty() });
    map.addSource('place', { type: 'geojson', data: empty() });
    map.addSource('sel', { type: 'geojson', data: empty() });

    map.addLayer({ id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#3dffb0', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 17, 22], 'line-blur': 8, 'line-opacity': 0.45 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 17, 8],
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#22e3ff', 1, '#3dffb0'] } });

    const kindColor = ['match', ['get', 'kind'], 'moto', '#ffb547', '#22e3ff'];
    map.addLayer({ id: 'lots-glow', type: 'circle', source: 'lots', filter: lotFilter(),
      paint: { 'circle-color': kindColor, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 12, 8, 17, 16], 'circle-blur': 1, 'circle-opacity': 0.6 } });
    map.addLayer({ id: 'lots', type: 'circle', source: 'lots', filter: lotFilter(),
      paint: {
        'circle-color': kindColor,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 10, 2.8, 14, 5, 17, 8],
        'circle-stroke-color': '#02060c', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0, 14, 1.5],
      } });
    map.addLayer({ id: 'lots-label', type: 'symbol', source: 'lots', minzoom: 15.5, filter: ['all', lotFilter(), ['has', 'name']],
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#bff4ff', 'text-halo-color': '#02060c', 'text-halo-width': 1.4 } });

    map.addLayer({ id: 'sel-ring', type: 'circle', source: 'sel',
      paint: { 'circle-radius': 18, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#3dffb0', 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'place-dot', type: 'circle', source: 'place',
      paint: { 'circle-radius': 8, 'circle-color': '#ff5ad9', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'me-halo', type: 'circle', source: 'me',
      paint: { 'circle-radius': 22, 'circle-color': '#22e3ff', 'circle-opacity': 0.18, 'circle-stroke-color': '#22e3ff', 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.5 } });
    map.addLayer({ id: 'me-dot', type: 'circle', source: 'me',
      paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': '#22e3ff', 'circle-stroke-width': 3 } });

    map.on('click', 'lots', e => {
      const f = e.features?.[0];
      if (!f) return;
      const idx = S.data.features.findIndex(x => x.properties.id === f.properties.id);
      if (idx >= 0) openDetail(idx, { fly: false });
    });
    map.on('mouseenter', 'lots', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'lots', () => { map.getCanvas().style.cursor = ''; });

    $('hud-count').textContent = `${n.toLocaleString()} P`;
    renderHome();
    window.__parkingReady = true;
  });

  map.on('move', () => {
    const c = map.getCenter();
    $('hud-pos').textContent = `${c.lat.toFixed(4)}N ${c.lng.toFixed(4)}E Z${map.getZoom().toFixed(1)}`;
  });
  map.on('dragstart', () => { if (S.nav) { S.nav.follow = false; $('nav-recenter').hidden = false; } });

  function lotFilter() { return S.mode === 'car' ? ['==', ['get', 'kind'], 'car'] : ['has', 'kind']; }
  function mapPadding() {
    if (isMobile()) {
      const sheet = document.body.classList.contains('navigating') ? 110 : $('panel').getBoundingClientRect().height;
      return { top: 90, bottom: Math.min(sheet + 10, innerHeight * 0.6), left: 20, right: 20 };
    }
    return { top: 40, bottom: 40, left: 440, right: 40 };
  }

  /* ───────── 文案工具 ───────── */
  function fmtDist(m) {
    if (!Number.isFinite(m)) return '—';
    if (m < 1000) return t('m', { n: Math.max(0, Math.round(m / (m < 100 ? 5 : 10)) * (m < 100 ? 5 : 10)) });
    return t('km', { n: (m / 1000).toFixed(m < 10000 ? 1 : 0) });
  }
  function fmtDur(s) {
    const min = Math.max(1, Math.round(s / 60));
    return min < 60 ? t('min', { n: min }) : t('hmin', { h: Math.floor(min / 60), m: min % 60 });
  }
  function lotName(p) {
    if (p.name) return p.name;
    if (p.kind === 'moto') return t('motoSpot');
    return I18N.has(`t_${p.t}`) ? t(`t_${p.t}`) : t('unnamed');
  }
  function lotTags(p) {
    const tags = [];
    if (p.name && p.t && I18N.has(`t_${p.t}`)) tags.push({ text: t(`t_${p.t}`) });
    if (p.fee === 'yes') tags.push({ text: t('fee_yes'), cls: 'fee-yes' });
    else if (p.fee === 'no') tags.push({ text: t('fee_no'), cls: 'fee-no' });
    else if (p.fee) tags.push({ text: t('feeOther', { v: p.fee }), cls: 'fee-yes' });
    if (p.cap) tags.push({ text: t('cap', { n: p.cap }) });
    if (p.acc && I18N.has(`acc_${p.acc}`)) tags.push({ text: t(`acc_${p.acc}`) });
    if (p.cov === 'yes') tags.push({ text: t('covered') });
    if (p.sup === 'yes') tags.push({ text: t('supervised') });
    return tags;
  }
  const tagHtml = tags => tags.map(x => `<span class="tag ${x.cls || ''}">${esc(x.text)}</span>`).join('');
  const refLabel = () => (S.ref?.kind === 'place' ? S.ref.label : t('nearMe'));
  const PIN_CAR = 'P';
  const PIN_MOTO = '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18.5" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5.5 16 9 10h6l3.5 6M9 10 7.5 7H5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  /* ───────── 抽屉（手机） ───────── */
  function setSheet(state) {
    const p = $('panel');
    p.classList.remove('sheet-peek', 'sheet-half', 'sheet-full');
    p.classList.add(`sheet-${state}`);
  }
  $('handle').addEventListener('click', () => {
    const p = $('panel');
    setSheet(p.classList.contains('sheet-peek') ? 'half' : p.classList.contains('sheet-half') ? 'full' : 'peek');
  });
  (() => {
    let y0 = null;
    $('handle').addEventListener('pointerdown', e => { y0 = e.clientY; });
    addEventListener('pointerup', e => {
      if (y0 == null) return;
      const dy = e.clientY - y0; y0 = null;
      if (Math.abs(dy) < 30) return;
      const p = $('panel');
      const order = ['peek', 'half', 'full'];
      const cur = order.findIndex(s => p.classList.contains(`sheet-${s}`));
      setSheet(order[Math.max(0, Math.min(2, cur + (dy < 0 ? 1 : -1)))]);
    });
  })();

  /* ───────── 视图 ───────── */
  function renderHome() {
    if (S.ref) return renderList();
    const n = S.data ? S.data.features.length : 0;
    $('view-list').innerHTML = `
      <div class="home">
        <div class="radar"><div class="radar-stat"><b>${n.toLocaleString()}</b><span>${esc(t('homeCount'))}</span></div></div>
        <p><b>${esc(t('homeHint'))}</b></p>
        <ol><li>${esc(t('homeStep1'))}</li><li>${esc(t('homeStep2'))}</li><li>${esc(t('homeStep3'))}</li></ol>
        <p class="note">${esc(t('homeNote'))}</p>
      </div>`;
  }

  function computeNearby() {
    if (!S.ref || !S.data) { S.lots = []; return; }
    const { lat, lng } = S.ref;
    const feats = S.data.features;
    const cand = [];
    for (let i = 0; i < feats.length; i++) {
      if (S.mode === 'car' && feats[i].properties.kind !== 'car') continue;
      if (Math.abs(S.lat[i] - lat) > 0.5 || Math.abs(S.lng[i] - lng) > 0.5) continue;
      cand.push({ i, d: hav(lat, lng, S.lat[i], S.lng[i]) });
    }
    if (cand.length < 30) {   // 偏远地区：放开范围
      cand.length = 0;
      for (let i = 0; i < feats.length; i++) {
        if (S.mode === 'car' && feats[i].properties.kind !== 'car') continue;
        cand.push({ i, d: hav(lat, lng, S.lat[i], S.lng[i]) });
      }
    }
    cand.sort((a, b) => a.d - b.d);
    S.lots = cand.slice(0, 30);
  }

  function renderList() {
    if (!S.ref) return renderHome();
    const items = S.lots.map(({ i, d }) => {
      const f = S.data.features[i], p = f.properties;
      const [lng, lat] = f.geometry.coordinates;
      return `<li class="lot${S.selected === i ? ' active' : ''}" data-testid="lot" data-i="${i}" data-lat="${lat}" data-lng="${lng}" data-kind="${p.kind}" data-distance-m="${Math.round(d)}" tabindex="0" role="button">
        <div class="lot-icon">${p.kind === 'moto' ? PIN_MOTO : PIN_CAR}</div>
        <div class="lot-main"><div class="lot-name">${esc(lotName(p))}</div><div class="lot-tags">${tagHtml(lotTags(p))}</div></div>
        <div class="lot-dist">${esc(fmtDist(d))}</div>
      </li>`;
    }).join('');
    $('view-list').innerHTML = `
      <div class="list-head"><h2>${esc(t('nearTitle', { place: ' ' })).replace(' ', `<em>${esc(refLabel())}</em>`)}</h2><small>${esc(t('lotsCount', { n: S.lots.length }))}</small></div>
      ${S.lots.length ? `<ul class="lots">${items}</ul>` : `<p class="note">${esc(t('noLots'))}</p>`}`;
  }

  $('view-list').addEventListener('click', e => {
    const li = e.target.closest('[data-testid=lot]');
    if (li) openDetail(+li.dataset.i);
  });
  $('view-list').addEventListener('keydown', e => {
    const li = e.target.closest('[data-testid=lot]');
    if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(+li.dataset.i); }
  });

  function setRef(ref) {
    S.ref = ref;
    computeNearby();
    closeDetail(false);
    renderList();
    $('panel-body').scrollTop = 0;
    if (isMobile()) setSheet('half');
  }

  function openDetail(i, { fly = true } = {}) {
    S.selected = i;
    const f = S.data.features[i], p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const from = S.ref || (S.fix ? { lat: S.fix.lat, lng: S.fix.lng, kind: 'me' } : null);
    const d = from ? hav(from.lat, from.lng, lat, lng) : NaN;
    const facts = [
      [t('f_type'), p.kind === 'moto' ? t('motoSpot') : (I18N.has(`t_${p.t}`) ? t(`t_${p.t}`) : '')],
      [t('f_fee'), p.fee === 'yes' ? t('fee_yes') : p.fee === 'no' ? t('fee_no') : p.fee || ''],
      [t('f_cap'), p.cap || ''],
      [t('f_hours'), p.oh || ''],
      [t('f_access'), p.acc ? (I18N.has(`acc_${p.acc}`) ? t(`acc_${p.acc}`) : p.acc) : ''],
      [t('f_operator'), p.op || ''],
    ].filter(([, v]) => v);
    facts.push([t('f_coords'), `${lat.toFixed(5)}, ${lng.toFixed(5)}`]);
    const osmType = { n: 'node', w: 'way', r: 'relation' }[p.id[0]];
    $('view-detail').innerHTML = `
      <div class="detail" data-testid="lot-detail">
        <div class="detail-kicker">${esc(t('kicker'))}</div>
        <div class="detail-top">
          <h2>${esc(lotName(p))}</h2>
          <button class="icon-btn" type="button" data-act="close" aria-label="${esc(t('back'))}">×</button>
        </div>
        ${Number.isFinite(d) ? `<div class="detail-dist">${esc(fmtDist(d))}<small>${esc(S.ref?.kind === 'place' ? t('fromPlace', { place: S.ref.label }) : t('away'))}</small></div>` : ''}
        <div class="lot-tags">${tagHtml(lotTags(p))}</div>
        <div class="actions">
          <button class="go-btn" type="button" data-testid="navigate" data-act="go">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 20 21l-8-4.5L4 21Z" fill="currentColor"/></svg>${esc(t('navigate'))}
          </button>
          <a class="handoff" data-testid="handoff-google" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving"><i style="background:#4285f4"></i>${esc(t('google'))}</a>
          <a class="handoff" data-testid="handoff-waze" target="_blank" rel="noopener" href="https://waze.com/ul?ll=${lat},${lng}&navigate=yes"><i style="background:#33ccff"></i>${esc(t('waze'))}</a>
        </div>
        <p class="note">${esc(t('lockTip'))}</p>
        <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
          <dt>${esc(t('f_osm'))}</dt><dd><a href="https://www.openstreetmap.org/${osmType}/${p.id.slice(1)}" target="_blank" rel="noopener" style="color:var(--cyan)">${esc(p.id)}</a></dd></dl>
        <p class="note">${facts.length < 4 ? esc(t('moreUnknown')) + ' ' : ''}${esc(t('feeUnknownNote'))}</p>
      </div>`;
    $('view-detail').hidden = false;
    $('panel').classList.add('has-detail');
    document.querySelectorAll('.lot.active').forEach(el => el.classList.remove('active'));
    document.querySelector(`.lot[data-i="${i}"]`)?.classList.add('active');
    map.getSource('sel')?.setData(pointFC(lng, lat));
    $('panel-body').scrollTop = 0;
    if (isMobile()) setSheet('half');
    if (fly) map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 16), duration: 700, padding: mapPadding() });
  }

  function closeDetail(render = true) {
    S.selected = null;
    $('view-detail').hidden = true;
    $('view-detail').innerHTML = '';
    $('panel').classList.remove('has-detail');
    map.getSource('sel')?.setData(empty());
    if (render) renderList();
  }

  $('view-detail').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closeDetail();
    else if (act === 'go') startNav(e.target.closest('button'));
  });

  /* ───────── 定位 ───────── */
  function toast(id, msg, ms = 9000) {
    const el = $(id);
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._timer);
    if (ms) el._timer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function ensureWatch() {
    if (S.watchId != null || !('geolocation' in navigator)) return;
    S.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
  }

  function onFix(pos) {
    const c = pos.coords;
    S.fix = { lat: c.latitude, lng: c.longitude, acc: c.accuracy || 0, heading: Number.isFinite(c.heading) ? c.heading : null, speed: c.speed };
    S.fixAt = Date.now();
    S.geoDenied = false;
    $('geo-error').hidden = true;
    $('hud-gps').textContent = `GPS ±${Math.round(S.fix.acc)}m`;
    $('hud-gps').classList.add('on');
    map.getSource('me')?.setData(pointFC(S.fix.lng, S.fix.lat));
    const waiters = S.geoWaiters.splice(0);
    waiters.forEach(w => w.resolve(S.fix));
    if (S.nav) navOnFix();
  }

  function onGeoError(err) {
    if (err.code === 1) {   // 被拒绝：停掉 watch，让下次点击能重新请求
      S.geoDenied = true;
      if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
      S.watchId = null;
      const waiters = S.geoWaiters.splice(0);
      waiters.forEach(w => w.reject(err));
    }
    // code 2/3：信号暂时不可用。已有定位时忽略（导航不中断），没有定位时由 getFix 的超时处理
  }

  // 用 watch 的最新位置；没有就等下一次更新（不调 getCurrentPosition——与 watch 并存时会卡住）
  function getFix(maxAge = 20000, wait = 15000) {
    if (!('geolocation' in navigator)) return Promise.reject({ code: 'unsupported' });
    if (!isSecureContext) return Promise.reject({ code: 'insecure' });
    if (S.fix && Date.now() - S.fixAt < maxAge) return Promise.resolve(S.fix);
    ensureWatch();
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      S.geoWaiters.push(w);
      setTimeout(() => {
        const k = S.geoWaiters.indexOf(w);
        if (k < 0) return;
        S.geoWaiters.splice(k, 1);
        if (S.fix) resolve(S.fix);   // 人没动时 watch 可能不再推送，用最后一次位置
        else reject({ code: 2 });
      }, S.fix ? 2500 : wait);
    });
  }

  function geoMessage(e) {
    if (e?.code === 1) return t('geoDenied');
    if (e?.code === 'unsupported') return t('geoUnsupported');
    if (e?.code === 'insecure') return t('geoInsecure');
    return t('geoUnavailable');
  }

  $('locate').addEventListener('click', async () => {
    const btn = $('locate');
    btn.classList.add('busy');
    try {
      const fix = await getFix(20000);
      setRef({ lat: fix.lat, lng: fix.lng, kind: 'me' });
      map.getSource('place')?.setData(empty());
      map.easeTo({ center: [fix.lng, fix.lat], zoom: 15, duration: 800, padding: mapPadding() });
    } catch (e) {
      toast('geo-error', geoMessage(e), 12000);
    } finally {
      btn.classList.remove('busy');
    }
  });

  /* ───────── 车型 / 语言 ───────── */
  function setMode(mode) {
    S.mode = mode;
    $('mode-car').setAttribute('aria-pressed', String(mode === 'car'));
    $('mode-moto').setAttribute('aria-pressed', String(mode === 'moto'));
    if (map.getLayer('lots')) {
      map.setFilter('lots', lotFilter());
      map.setFilter('lots-glow', lotFilter());
      map.setFilter('lots-label', ['all', lotFilter(), ['has', 'name']]);
    }
    if (S.ref) {
      computeNearby();
      if (S.selected == null) renderList(); else { const sel = S.selected; renderList(); openDetail(sel, { fly: false }); }
    }
  }
  $('mode-car').addEventListener('click', () => setMode('car'));
  $('mode-moto').addEventListener('click', () => setMode('moto'));

  function applyLang() {
    document.documentElement.lang = I18N.htmlLang();
    $('lang').textContent = I18N.lang === 'en' ? '中文' : 'EN';
    $('lang').setAttribute('aria-label', I18N.lang === 'en' ? '切换到中文' : 'Switch to English');
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    document.title = I18N.lang === 'en' ? 'ParkRadar · Philippines parking navigation' : '泊车雷达 ParkingPH · 菲律宾停车场导航';
    if (S.data) {
      if (S.ref) { const sel = S.selected; renderList(); if (sel != null) openDetail(sel, { fly: false }); } else renderHome();
    }
    $('geo-error').hidden = true;
    $('route-error').hidden = true;
    if (S.nav) updateNavUI();
  }
  $('lang').addEventListener('click', () => { I18N.set(I18N.lang === 'en' ? 'zh' : 'en'); applyLang(); });
  applyLang();

  /* ───────── 搜索（Photon，防抖，不逐键打 Nominatim） ───────── */
  let searchTimer = null, searchCtl = null, suggestions = [], activeIdx = -1;
  const q = $('q'), box = $('suggest');

  async function runSearch(text) {
    searchCtl?.abort();
    searchCtl = new AbortController();
    const c = map.getCenter();
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=6&bbox=116.9,4.5,126.7,21.2&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}`;
    try {
      const res = await fetch(url, { signal: searchCtl.signal });
      const j = await res.json();
      suggestions = (j.features || []).filter(f => !f.properties.countrycode || f.properties.countrycode === 'PH').map(f => {
        const p = f.properties;
        const main = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || '—';
        const sub = [p.street && p.name ? p.street : '', p.district || p.locality, p.city, p.state].filter(Boolean).filter((v, k, a) => a.indexOf(v) === k).join(' · ');
        return { label: main, sub, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
      });
      activeIdx = -1;
      renderSuggest();
    } catch (e) {
      if (e.name === 'AbortError') return;
      suggestions = [];
      box.innerHTML = `<li class="empty">${esc(t('searchFail'))}</li>`;
      box.hidden = false;
    }
  }
  function renderSuggest() {
    if (!suggestions.length) { box.innerHTML = `<li class="empty">${esc(t('noSuggest'))}</li>`; box.hidden = false; return; }
    box.innerHTML = suggestions.map((s, k) => `<li data-testid="suggestion" role="option" data-k="${k}" class="${k === activeIdx ? 'active' : ''}"><b>${esc(s.label)}</b>${s.sub ? `<small>${esc(s.sub)}</small>` : ''}</li>`).join('');
    box.hidden = false;
  }
  function pickSuggestion(k) {
    const s = suggestions[k];
    if (!s) return;
    box.hidden = true;
    q.value = s.label;
    q.blur();
    setRef({ lat: s.lat, lng: s.lng, label: s.label, kind: 'place' });
    map.getSource('place')?.setData(pointFC(s.lng, s.lat));
    map.easeTo({ center: [s.lng, s.lat], zoom: 15, duration: 800, padding: mapPadding() });
  }
  q.addEventListener('input', () => {
    $('q-clear').hidden = !q.value;
    clearTimeout(searchTimer);
    const text = q.value.trim();
    if (text.length < 2) { box.hidden = true; return; }
    searchTimer = setTimeout(() => runSearch(text), 350);
  });
  q.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!box.hidden && suggestions.length) pickSuggestion(activeIdx >= 0 ? activeIdx : 0);
      else if (q.value.trim().length >= 2) { clearTimeout(searchTimer); runSearch(q.value.trim()); }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      renderSuggest();
    } else if (e.key === 'Escape') box.hidden = true;
  });
  box.addEventListener('click', e => {
    const li = e.target.closest('[data-testid=suggestion]');
    if (li) pickSuggestion(+li.dataset.k);
  });
  $('q-clear').addEventListener('click', () => { q.value = ''; $('q-clear').hidden = true; box.hidden = true; q.focus(); });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.topbar')) box.hidden = true; });

  /* ───────── 语音 / 常亮 ───────── */
  let voices = [];
  const loadVoices = () => { try { voices = speechSynthesis.getVoices(); } catch { voices = []; } };
  if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.addEventListener?.('voiceschanged', loadVoices); }

  function speak(text) {
    if (S.muted || !('speechSynthesis' in window)) return;
    try {
      const lang = I18N.speechLang();
      const prefix = lang.slice(0, 2);
      const voice = voices.find(v => v.lang?.replace('_', '-').startsWith(lang)) || voices.find(v => v.lang?.startsWith(prefix));
      if (voices.length && !voice) {        // 有语音列表但没有该语言：只显示文字
        if (S.nav && !S.nav.voiceWarned) { S.nav.voiceWarned = true; toast('geo-error', t('voiceNone'), 5000); }
        return;
      }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      if (voice) u.voice = voice;
      speechSynthesis.speak(u);
    } catch { /* 朗读失败不影响导航 */ }
  }
  function unlockSpeech() {   // 手机浏览器要求在点击里先说一次
    try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch { /* ignore */ }
  }
  async function keepAwake() {
    try { if (S.nav && 'wakeLock' in navigator && !S.nav.wake) { S.nav.wake = await navigator.wakeLock.request('screen'); S.nav.wake.addEventListener?.('release', () => { if (S.nav) S.nav.wake = null; }); } } catch { /* 不支持或被拒 */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.nav) keepAwake(); });

  /* ───────── 导航 ───────── */
  const OFF_ROUTE_M = 50;
  const REROUTE_COOLDOWN_MS = 8000;
  const ARROW = {
    straight: 'M12 3 18 10h-4v11h-4V10H6Z', right: 'M5 21V11a3 3 0 0 1 3-3h7V4l6 6-6 6v-4H9v9Z', left: 'M19 21V11a3 3 0 0 0-3-3H9V4l-6 6 6 6v-4h6v9Z',
    'slight-right': 'M7 21v-8l7.5-7.5L12 3h9v9l-2.5-2.5L11 17v4Z', 'slight-left': 'M17 21v-8L9.5 5.5 12 3H3v9l2.5-2.5L13 17v4Z',
    uturn: 'M6 21V9a6 6 0 0 1 12 0v4h3l-5 6-5-6h3V9a2 2 0 0 0-4 0v12Z',
    arrive: 'M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7Zm0 4.5A2.5 2.5 0 1 0 12 11.5 2.5 2.5 0 0 0 12 6.5Z',
    roundabout: 'M12 5a7 7 0 1 1-7 7h3a4 4 0 1 0 4-4v3L7 6.5 12 2Z',
  };
  const arrowFor = act => ARROW[act] || ARROW[{ 'sharp-right': 'right', 'sharp-left': 'left', 'ramp-right': 'slight-right', 'exit-right': 'slight-right', 'keep-right': 'slight-right', 'ramp-left': 'slight-left', 'exit-left': 'slight-left', 'keep-left': 'slight-left', 'roundabout-exit': 'roundabout' }[act]] || ARROW.straight;

  function actText(step) {
    let s = t(`a_${step.act}`, { n: step.exit || 1 });
    if (step.street && !['arrive', 'depart', 'roundabout'].includes(step.act)) s += t(step.act === 'straight' || step.act === 'keep-straight' ? 'along' : 'onto', { s: step.street });
    return s;
  }

  async function startNav(btn) {
    if (S.selected == null) return;
    unlockSpeech();
    const i = S.selected;
    const [lng, lat] = S.data.features[i].geometry.coordinates;
    if (S.nav) stopNav(false);
    const nav = S.nav = { dest: { lat, lng }, idx: i, route: null, follow: true, pending: false, lastRouteAt: 0, spoken: new Set(), arrived: false, ctl: null, timer: null, wake: null, voiceWarned: false };
    keepAwake();
    if (btn) { btn.disabled = true; btn.lastChild.textContent = t('routing'); }
    try {
      const fix = await getFix(60000);
      if (S.nav !== nav) return;
      const ok = await requestRoute(fix, true);
      if (!ok) { stopNav(false); return; }
      document.body.classList.add('navigating');
      $('nav').hidden = false;
      map.fitBounds(boundsOf(nav.route.coords), { padding: mapPadding(), duration: 700, maxZoom: 17 });
      nav.follow = false;
      setTimeout(() => { if (S.nav === nav) { nav.follow = true; followCamera(); } }, 2500);
      updateNavUI(true);
    } catch (e) {
      stopNav(false);
      toast('geo-error', geoMessage(e), 12000);
    } finally {
      if (btn?.isConnected) { btn.disabled = false; btn.lastChild.textContent = t('navigate'); }
    }
  }

  async function requestRoute(from, first) {
    const nav = S.nav;
    if (!nav || nav.pending) return false;
    nav.pending = true;
    nav.lastRouteAt = Date.now();
    nav.ctl = new AbortController();
    try {
      const route = await Routing.plan({ lat: from.lat, lng: from.lng, heading: from.heading }, nav.dest, S.mode, nav.ctl.signal);
      if (S.nav !== nav) return false;
      nav.route = route;
      nav.spoken.clear();
      nav.arrived = false;
      nav.lastRouteAt = Date.now();
      map.getSource('route')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.coords } });
      $('route-error').hidden = true;
      if (route.degraded) toast('geo-error', t('motoDegraded'), 8000);
      nav.progress = Routing.project(route, from.lat, from.lng);
      if (!first) { speak(t('rerouted')); updateNavUI(true); }
      return true;
    } catch (e) {
      if (S.nav !== nav || e.name === 'AbortError') return false;
      console.warn('route failed', e);
      toast('route-error', first ? t('routeFail') : t('rerouteFail'), 10000);
      nav.lastRouteAt = Date.now();
      return false;
    } finally {
      if (S.nav === nav) nav.pending = false;
    }
  }

  function navOnFix() {
    const nav = S.nav;
    if (!nav?.route || !S.fix) return;
    const fix = S.fix;
    const pr = Routing.project(nav.route, fix.lat, fix.lng);
    const threshold = OFF_ROUTE_M + Math.min(fix.acc || 0, 50);
    if (pr.dist > threshold && !nav.arrived) {
      scheduleReroute();
    } else {
      nav.progress = pr;
    }
    updateNavUI();
    followCamera();
  }

  function scheduleReroute() {
    const nav = S.nav;
    if (!nav || nav.pending) return;
    const wait = REROUTE_COOLDOWN_MS - (Date.now() - nav.lastRouteAt);
    if (wait <= 0) { requestRoute(S.fix, false); return; }
    if (nav.timer) return;
    nav.timer = setTimeout(() => {
      nav.timer = null;
      if (S.nav !== nav || !S.fix || !nav.route) return;
      const pr = Routing.project(nav.route, S.fix.lat, S.fix.lng);
      if (pr.dist > OFF_ROUTE_M + Math.min(S.fix.acc || 0, 50)) requestRoute(S.fix, false);
    }, wait + 50);
  }

  function updateNavUI(forceSpeak = false) {
    const nav = S.nav;
    if (!nav?.route) return;
    const r = nav.route;
    const pr = nav.progress || { along: 0, seg: 0 };
    const remaining = Math.max(0, r.distance - pr.along);
    const toDest = S.fix ? hav(S.fix.lat, S.fix.lng, nav.dest.lat, nav.dest.lng) : Infinity;
    $('nav').dataset.remainingM = String(Math.round(remaining));

    if (!nav.arrived && (remaining < 30 || toDest < 35)) {
      nav.arrived = true;
      speak(t('arrived'));
    }
    $('nav').classList.toggle('arrived', nav.arrived);

    let step, distTo;
    if (nav.arrived) {
      step = { act: 'arrive' };
      $('nav-dist').textContent = fmtDist(remaining);
      $('nav-instruction').textContent = t('arrived');
    } else {
      step = r.steps.find(s => s.begin > pr.seg && s.act !== 'depart') || r.steps[r.steps.length - 1] || { act: 'arrive', begin: r.coords.length - 1 };
      distTo = Math.max(0, r.cum[Math.min(step.begin, r.cum.length - 1)] - pr.along);
      const text = actText(step);
      $('nav-dist').textContent = fmtDist(distTo);
      $('nav-instruction').textContent = distTo < 30 ? t('now', { act: text }) : t('inDist', { d: fmtDist(distTo), act: text });
      const key = `${step.begin}:${step.act}`;
      const say = s => speak(s.charAt(0).toUpperCase() + s.slice(1));
      if (forceSpeak) { nav.spoken.add(`${key}:far`); say(distTo < 30 ? t('now', { act: text }) : t('inDist', { d: fmtDist(distTo), act: text })); }
      else if (distTo <= 80 && !nav.spoken.has(`${key}:near`)) { nav.spoken.add(`${key}:near`); nav.spoken.add(`${key}:far`); say(t('now', { act: text })); }
      else if (distTo <= 400 && distTo > 80 && !nav.spoken.has(`${key}:far`)) { nav.spoken.add(`${key}:far`); say(t('inDist', { d: fmtDist(distTo), act: text })); }
    }
    $('nav-arrow').innerHTML = `<svg viewBox="0 0 24 24"><path d="${arrowFor(step.act)}" fill="currentColor"/></svg>`;
    $('nav-remaining').textContent = fmtDist(remaining);
    const secs = r.distance > 0 ? r.duration * (remaining / r.distance) : 0;
    $('nav-eta').textContent = fmtDur(secs);
    const at = new Date(Date.now() + secs * 1000);
    $('nav-arrive').textContent = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  }

  function followCamera() {
    const nav = S.nav;
    if (!nav?.follow || !S.fix || !nav.route) return;
    const bearing = Number.isFinite(S.fix.heading) && (S.fix.speed || 0) > 1.5 ? S.fix.heading : Routing.bearingAt(nav.route, nav.progress?.seg || 0);
    map.easeTo({ center: [S.fix.lng, S.fix.lat], zoom: 16.5, bearing, pitch: 50, duration: 900, padding: isMobile() ? { top: 140, bottom: 200, left: 0, right: 0 } : { top: 140, bottom: 140, left: 432, right: 0 } });
  }

  function boundsOf(coords) {
    const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
    coords.forEach(c => b.extend(c));
    return b;
  }

  function stopNav(restore = true) {
    const nav = S.nav;
    if (!nav) return;
    S.nav = null;
    nav.ctl?.abort();
    clearTimeout(nav.timer);
    try { nav.wake?.release(); } catch { /* ignore */ }
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    map.getSource('route')?.setData(empty());
    $('nav').hidden = true;
    $('nav').classList.remove('arrived');
    $('nav-recenter').hidden = true;
    document.body.classList.remove('navigating');
    if (restore) {
      map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      if (isMobile()) setSheet('half');
    }
  }

  $('nav-stop').addEventListener('click', () => stopNav(true));
  $('nav-recenter').addEventListener('click', () => { if (S.nav) { S.nav.follow = true; $('nav-recenter').hidden = true; followCamera(); } });
  $('nav-mute').addEventListener('click', () => {
    S.muted = !S.muted;
    $('nav-mute').setAttribute('aria-pressed', String(S.muted));
    if (S.muted) try { speechSynthesis.cancel(); } catch { /* ignore */ }
  });

})();
