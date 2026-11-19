import { t, fmtNum } from './i18n.js';
import * as G from './graph.js';
import * as R from './reports.js';
import * as Q from './search.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pref = {
  get(k) { try { return localStorage.getItem('dsr.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('dsr.' + k, v); } catch { /* storage may be blocked */ } },
};
const isNightNow = () => { const h = new Date().getHours(); return h >= 18 || h < 6; };

const S = {
  lang: pref.get('lang') === 'en' ? 'en' : 'bn',
  night: isNightNow(),
  origin: null, dest: null,            // {node, ll:[lon,lat]}
  mode: 'plan',                        // 'plan' | 'report'
  groups: [], selected: 0, error: null,
  layers: { risk: false, police: true, hospital: false },
  state: 'loading',                    // 'loading' | 'ready' | 'failed'
  locating: false, pending: null,      // pending: street hit while the report dialog is open
};
let g, map, tiles, canvas, routeLayer, reportLayer, hlLayer;
let baseLines = [], poi = {}, pins = { o: null, d: null }, sIndex = [];
const tr = (k, v) => t(S.lang, k, v);
const whenWord = () => tr(S.night ? 'when.night' : 'when.day');
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const areaName = () => (g ? g.meta.area[S.lang] : '');

const NAME_ORDER = ['shortest', 'balanced', 'safest'];
const VAR = { shortest: '--r1', balanced: '--r2', safest: '--r3' };
const DASH = { shortest: '1 11', balanced: '14 10', safest: null };

/* ---------- text, theme ---------- */
function applyStatic() {
  document.documentElement.lang = S.lang;
  document.title = `${tr('app.title')} · ${tr('app.tagline')}`;
  $$('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
  $$('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', tr(el.dataset.i18nAria)));
  $$('[data-i18n-title]').forEach((el) => el.setAttribute('title', tr(el.dataset.i18nTitle)));
  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = tr(el.dataset.i18nPh); });
  const lb = $('#btn-lang');
  lb.textContent = tr('lang.toggle');
  lb.setAttribute('aria-label', tr('lang.toggle.label'));
  lb.lang = S.lang === 'bn' ? 'en' : 'bn';
}

function applyTheme() {
  document.documentElement.dataset.theme = S.night ? 'night' : 'day';
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = S.night ? '#171e3a' : '#ffffff';
}

let toastT;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 4200);
}

/* ---------- formatting ---------- */
const fmtDist = (m) => (m >= 1000 ? tr('route.km', { n: Math.round(m / 100) / 10 }) : tr('route.m', { n: Math.max(10, Math.round(m / 10) * 10) }));
const minutes = (m) => Math.max(1, Math.round(m / 83.3));   // about 5 km/h
const pct = (x) => Math.round(x * 100);

function reasonsFor(gr) {
  const out = [], when = whenWord(), hi = pct(gr.high_risk_share);
  out.push(hi <= 5 ? tr('r.hiNone', { when }) : tr('r.hiSome', { n: hi, when }));
  out.push(gr.lighting_unknown_share > 0.8 ? tr('r.lightUnknown') : tr('r.lightKnown', { n: pct(gr.lit_share) }));
  if (gr.quiet_share >= 0.25) out.push(tr('r.quiet', { n: pct(gr.quiet_share) }));
  if (gr.extra_m >= 10) out.push(tr('r.longer', { n: Math.round(gr.extra_m) }));
  if (gr.nearest_police_m != null) out.push(tr('r.police', { n: Math.max(10, Math.round(gr.nearest_police_m / 10) * 10) }));
  if (gr.user_reports) out.push(tr('r.reports', { n: gr.user_reports }));
  return out;
}

/* ---------- sheet rendering ---------- */
function styleName(gr) { return gr.names[0]; }   // highest-alpha name drives the line style

function sampleSVG(name) {
  const d = DASH[name];
  return `<svg class="sample" width="44" height="14" viewBox="0 0 44 14" aria-hidden="true">
    <line x1="4" y1="7" x2="40" y2="7" stroke="var(--casing)" stroke-width="9" stroke-linecap="round"/>
    <line x1="4" y1="7" x2="40" y2="7" stroke="var(${VAR[name]})" stroke-width="5" stroke-linecap="round" ${d ? `stroke-dasharray="${d}"` : ''}/></svg>`;
}

function renderRoutes() {
  const box = $('#routes-box'), ul = $('#routes'), msg = $('#route-msg');
  ul.innerHTML = '';
  msg.hidden = !S.error;
  if (S.error) msg.textContent = tr(S.error === 'same' ? 'sameSpot' : 'noRoute');
  box.hidden = !S.groups.length;
  if (!S.groups.length) return;
  $('#no-alt').hidden = !(S.groups.length === 1 && S.groups[0].names.length === NAME_ORDER.length);

  S.groups.forEach((gr, i) => {
    const sel = i === S.selected, name = styleName(gr);
    const names = [...gr.names].sort((a, b) => NAME_ORDER.indexOf(b) - NAME_ORDER.indexOf(a)).map((n) => tr('route.' + n));
    const li = document.createElement('li');
    li.className = 'route' + (sel ? ' is-sel' : '');
    li.style.setProperty('--c', `var(${VAR[name]})`);
    const hi = pct(gr.high_risk_share);
    li.innerHTML = `
      <button type="button" class="route-btn" aria-pressed="${sel}" data-i="${i}">
        ${sampleSVG(name)}
        <span>
          <span class="route-name">${names.join(', ')}${gr.names.length > 1 ? ` <span class="route-same">(${tr('route.same')})</span>` : ''}</span>
          <span class="route-meta"><span>${fmtDist(gr.length_m)}</span><span>${tr('route.min', { n: minutes(gr.length_m) })}</span><span class="badge">${tr('route.estimate')}</span></span>
        </span>
      </button>
      ${sel ? `<div class="route-detail">
        <div class="meter" role="img" aria-label="${tr('route.hiShare', { n: hi })}"><span style="width:${Math.max(2, hi)}%"></span></div>
        <div class="meter-label">${tr('route.hiShare', { n: hi })}</div>
        <p class="why">${tr('why')}</p>
        <ul class="reasons">${reasonsFor(gr).map((r) => `<li>${r}</li>`).join('')}</ul>
        <p class="caveat">${tr('r.caveat')}</p></div>` : ''}`;
    ul.appendChild(li);
  });
}

function render() {
  const hint = $('#hint');
  if (S.state === 'loading') hint.textContent = tr('hint.loading');
  else if (S.state === 'failed') hint.textContent = tr('hint.loadfail');
  else if (S.locating) hint.textContent = tr('loc.busy');
  else if (S.mode === 'report') hint.textContent = tr('hint.report');
  else if (!S.origin) hint.textContent = tr('hint.origin');
  else if (!S.dest) hint.textContent = tr('hint.dest');
  else hint.textContent = tr('hint.done');

  syncFields();
  $('#t-day').setAttribute('aria-pressed', String(!S.night));
  $('#t-night').setAttribute('aria-pressed', String(S.night));
  $('#btn-reset').disabled = !(S.origin || S.dest);
  $('#btn-swap').disabled = !(S.origin && S.dest);
  $('#btn-loc').disabled = S.state !== 'ready';
  const rb = $('#btn-report');
  rb.setAttribute('aria-pressed', String(S.mode === 'report'));
  rb.disabled = S.state !== 'ready';
  $('#report-label').textContent = tr(S.mode === 'report' ? 'tools.reportOn' : 'tools.report');
  $('#mine-label').textContent = tr('tools.mine', { n: R.getReports().length });
  $('#risk-legend').hidden = !S.layers.risk;
  const collapsed = $('#sheet').classList.contains('collapsed');
  $('#sheet-label').textContent = tr(collapsed ? 'sheet.expand' : 'sheet.collapse');
  renderRoutes();
}

/* ---------- map layers ---------- */
const mkIcon = (html, size, cls = '') => L.divIcon({ html, className: cls, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

function paintNetwork() {
  const risk = S.night ? g.risk.night : g.risk.day;
  const ramp = [1, 2, 3, 4, 5].map((i) => cssVar('--rk' + i)), base = cssVar('--base-net');
  const cls = (r) => (r < 0.45 ? 0 : r < 0.55 ? 1 : r < 0.62 ? 2 : r < 0.67 ? 3 : 4);
  for (const { line, e } of baseLines) {
    line.setStyle(S.layers.risk ? { color: ramp[cls(risk[e.i])], weight: 3.5, opacity: 0.95 }
                                : { color: base, weight: 1.6, opacity: 0.75 });
  }
}

function drawRoutes() {
  routeLayer.clearLayers();
  if (!S.groups.length) return;
  const casing = cssVar('--casing');
  const order = S.groups.map((_, i) => i).filter((i) => i !== S.selected).concat(S.selected);
  for (const i of order) {
    const gr = S.groups[i], name = styleName(gr), sel = i === S.selected;
    const ll = gr.coords.map((c) => [c[1], c[0]]);
    const w = sel ? 7 : 5;
    L.polyline(ll, { color: casing, weight: w + 4, opacity: 0.92, interactive: false, lineCap: 'round' }).addTo(routeLayer);
    L.polyline(ll, { color: cssVar(VAR[name]), weight: w, opacity: sel ? 1 : 0.85, dashArray: DASH[name], interactive: false, lineCap: 'round' }).addTo(routeLayer);
  }
}

/** Zoom to a point and centre it in the part of the map the bottom panel does not cover. */
function zoomTo(latlng, z) {
  map.setView(latlng, z, { animate: false });
  if (window.matchMedia('(max-width: 899px)').matches) map.panBy([0, $('#sheet').offsetHeight / 2], { animate: false });
}

function fitRoutes() {
  if (!S.groups.length) return;
  const pts = S.groups.flatMap((gr) => gr.coords.map((c) => [c[1], c[0]]));
  const phone = window.matchMedia('(max-width: 899px)').matches;
  const sheetH = phone ? $('#sheet').offsetHeight : 0;
  map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [32, 32], paddingBottomRight: [32, sheetH + 24], maxZoom: 18 });
}

function setPin(which, ll) {
  const label = which === 'o' ? 'A' : 'B';
  if (!pins[which]) {
    const m = L.marker([ll[1], ll[0]], {
      draggable: true, keyboard: false, zIndexOffset: 1000,
      icon: L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [4, 34], html: `<div class="pin"><span>${label}</span></div>` }),
    }).addTo(map);
    m.on('dragend', () => {
      const p = m.getLatLng();
      if (!placePoint(which, p.lng, p.lat)) {
        const cur = which === 'o' ? S.origin : S.dest;
        m.setLatLng([cur.ll[1], cur.ll[0]]);
      }
    });
    pins[which] = m;
  } else pins[which].setLatLng([ll[1], ll[0]]);
}

function drawReports() {
  reportLayer.clearLayers();
  for (const r of R.getReports()) {
    if (r.dv !== g.meta.generated || !r.loc) continue;
    L.marker([r.loc[1], r.loc[0]], { icon: mkIcon('', 26, `mk k-${r.kind}`), keyboard: false, interactive: false }).addTo(reportLayer);
  }
}

function applyReports() {
  G.setOverrides(g, R.toOverrides(R.getReports(), g.meta.generated));
  paintNetwork(); drawReports(); recompute(false);
}

/* ---------- planning ---------- */
/** What to call a point the user picked on the map: the named street under it, or just "point on the map". */
function describePoint(lon, lat) {
  const hit = G.snapEdge(g, lon, lat, 45);
  return hit && hit.edge.name ? { kind: 'street', name: hit.edge.name } : { kind: 'map' };
}
const pointLabel = (pt) => (pt.kind === 'street' ? pt.name : tr('place.' + pt.kind));

function placePoint(which, lon, lat, how) {
  const nn = G.nearestNode(g, lon, lat);
  if (nn.dist > G.COVERAGE_M) { toast(tr('outside', { area: areaName() })); return false; }
  const ll = g.nodes[nn.id];
  const pt = { node: nn.id, ll, ...(how || describePoint(lon, lat)) };
  if (which === 'o') S.origin = pt; else S.dest = pt;
  setPin(which, ll);
  recompute(true);
  return true;
}

function recompute(fit) {
  S.error = null;
  if (S.origin && S.dest) {
    const res = G.routeOptions(g, S.origin.node, S.dest.node, S.night);
    if (res.error) { S.groups = []; S.error = res.error; } else { S.groups = res.groups; S.selected = 0; }
  } else S.groups = [];
  drawRoutes(); render();
  if (fit && S.groups.length) fitRoutes();
}

function clearPoint(which) {
  if (which === 'o') S.origin = null; else S.dest = null;
  if (pins[which]) { pins[which].remove(); pins[which] = null; }
  recompute(false);
}

/* ---------- start / destination fields (offline street-name search) ---------- */
const FIELD = { o: { inp: '#q-o', list: '#sg-o', clr: '#clr-o' }, d: { inp: '#q-d', list: '#sg-d', clr: '#clr-d' } };

function syncFields() {
  for (const w of ['o', 'd']) {
    const pt = w === 'o' ? S.origin : S.dest, el = $(FIELD[w].inp);
    if (document.activeElement !== el) el.value = pt ? pointLabel(pt) : '';
    $(FIELD[w].clr).hidden = !pt;
    el.disabled = S.state !== 'ready';
  }
}

function pickResult(which, it) {
  if (!placePoint(which, it.lon, it.lat, { kind: 'street', name: it.name })) return;
  if (!(S.origin && S.dest)) zoomTo([it.lat, it.lon], Math.max(map.getZoom(), 16));
}

function bindField(which) {
  const f = FIELD[which], inp = $(f.inp), ul = $(f.list);
  let items = [], act = -1, query = '';
  const optId = (i) => `${f.list.slice(1)}-${i}`;
  const close = () => { ul.hidden = true; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); };
  function draw() {
    ul.innerHTML = '';
    if (!query.trim()) { close(); return; }
    if (!items.length) {
      ul.innerHTML = `<li class="sg-none" role="presentation">${tr('search.none')}</li>`;
    } else {
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.id = optId(i); li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(i === act));
        li.innerHTML = `<span class="sg-name"></span><span class="sg-meta">${tr('search.meta', { dir: tr('dir.' + it.dir), len: fmtDist(it.len_m) })}</span>`;
        li.firstChild.textContent = it.name;
        li.addEventListener('mousedown', (ev) => ev.preventDefault());   // keep focus so blur does not close the list first
        li.addEventListener('click', () => { pickResult(which, it); inp.blur(); });
        ul.appendChild(li);
      });
    }
    ul.hidden = false; inp.setAttribute('aria-expanded', 'true');
    if (act >= 0) inp.setAttribute('aria-activedescendant', optId(act)); else inp.removeAttribute('aria-activedescendant');
    $('#sg-status').textContent = items.length ? tr('search.count', { n: items.length }) : tr('search.none');
  }
  inp.addEventListener('focus', () => { $('#sheet').classList.add('searching'); inp.select(); });
  inp.addEventListener('blur', () => { close(); $('#sheet').classList.remove('searching'); render(); });
  inp.addEventListener('input', () => {
    query = inp.value; items = S.state === 'ready' ? Q.search(sIndex, query, 5) : []; act = items.length ? 0 : -1; draw();
  });
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!items.length) return; ev.preventDefault();
      act = (act + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; draw();
    } else if (ev.key === 'Enter') {
      if (act >= 0 && items[act]) { ev.preventDefault(); pickResult(which, items[act]); inp.blur(); }
    } else if (ev.key === 'Escape') { close(); inp.blur(); }
  });
  $(f.clr).addEventListener('click', () => { clearPoint(which); inp.value = ''; inp.focus(); });
}

function reset() {
  S.origin = S.dest = null; S.groups = []; S.error = null; S.mode = 'plan';
  for (const k of ['o', 'd']) if (pins[k]) { pins[k].remove(); pins[k] = null; }
  $('#map').classList.remove('is-reporting');
  drawRoutes(); render();
}

function swap() {
  if (!(S.origin && S.dest)) return;
  [S.origin, S.dest] = [S.dest, S.origin];
  setPin('o', S.origin.ll); setPin('d', S.dest.ll);
  recompute(false);
}

function useMyLocation() {
  if (!navigator.geolocation) { toast(tr('loc.fail')); return; }
  S.locating = true; render();
  navigator.geolocation.getCurrentPosition((pos) => {
    S.locating = false;
    if (!placePoint('o', pos.coords.longitude, pos.coords.latitude, { kind: 'me' })) render();
    else if (S.origin && !S.dest) zoomTo([S.origin.ll[1], S.origin.ll[0]], Math.max(map.getZoom(), 16));
    render();
  }, () => { S.locating = false; toast(tr('loc.fail')); render(); },
  { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
}

function setTime(night) {
  if (S.night === night) return;
  S.night = night; applyTheme(); paintNetwork(); recompute(false);
}

function setMode(mode) {
  S.mode = mode;
  $('#map').classList.toggle('is-reporting', mode === 'report');
  render();
}

/* ---------- reporting ---------- */
function openReport(hit) {
  S.pending = hit;
  $('#toast').classList.remove('show');
  const e = hit.edge;
  hit.stretch = G.stretchOf(g, e);
  $('#rep-street').textContent = e.name || tr('rep.unnamed');
  $('#rep-stretch').textContent = tr('rep.stretch', { n: Math.max(10, Math.round(hit.stretch.length_m / 10) * 10) });
  hlLayer.clearLayers();
  for (const k of hit.stretch.keys) {
    const se = g.edges[g.byKey.get(k)[0]];
    L.polyline(se.pts.map((p) => [p[1], p[0]]), { color: cssVar('--focus'), weight: 10, opacity: 0.55, interactive: false, lineCap: 'round' }).addTo(hlLayer);
  }
  $$('#dlg-report [data-when]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.when === (S.night ? 'night' : 'day'))));
  $('#dlg-report').showModal();
}

function saveReport(kind) {
  const hit = S.pending; if (!hit) return;
  const whenBtn = $('#dlg-report [data-when][aria-pressed="true"]');
  const e = hit.edge, a = e.pts[0], b = e.pts[e.pts.length - 1];
  R.addReport({ keys: hit.stretch.keys, length_m: hit.stretch.length_m, name: e.name, kind,
                when: whenBtn ? whenBtn.dataset.when : 'night',
                loc: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dv: g.meta.generated });
  $('#dlg-report').close();
  setMode('plan'); applyReports(); toast(tr('rep.saved'));
}

const KIND_KEY = { lit: 'rep.lit', dark: 'rep.dark', unsafe: 'rep.unsafe' };
function openMine() {
  const ul = $('#mine-list'), list = R.getReports();
  ul.innerHTML = list.length ? '' : `<li style="display:block"><p class="note">${tr('mine.empty')}</p></li>`;
  for (const r of [...list].reverse()) {
    const li = document.createElement('li');
    const when = r.kind === 'unsafe' ? ` · ${tr(r.when === 'day' ? 'when.day' : 'when.night')}` : '';
    li.innerHTML = `<span class="kind-ico k-${r.kind}" aria-hidden="true"></span>
      <span><strong>${tr(KIND_KEY[r.kind])}</strong>${when}<br><span class="sub">${r.name || tr('rep.unnamed')}, ${r.date}</span></span>
      <button type="button" data-del="${r.id}">${tr('mine.delete')}</button>`;
    ul.appendChild(li);
  }
  $('#btn-export').disabled = !list.length;
  if (!$('#dlg-mine').open) $('#dlg-mine').showModal();
}

function exportReports() {
  const blob = new Blob([R.exportJSON(R.getReports())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'dhaka-safe-routes-reports.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- about ---------- */
function fillAbout() {
  const lit = g ? Math.round(g.meta.lit_tag_share * 1000) / 10 : 0;
  const tel = (n, d, label) => `<div class="help"><a href="tel:${n}">${tr(label)}</a><span>${tr(d)}</span></div>`;
  $('#about-body').innerHTML = `
    <h3>${tr('about.what.h')}</h3><p>${tr('about.what')}</p>
    <h3>${tr('about.how.h')}</h3><p>${tr('about.how')}</p>
    <h3>${tr('about.limits.h')}</h3>
    <ul><li>${tr('about.l1')}</li><li>${tr('about.l2', { n: lit })}</li><li>${tr('about.l3')}</li><li>${tr('about.l4')}</li></ul>
    <h3>${tr('about.priv.h')}</h3><p>${tr('about.priv')}</p>
    <h3>${tr('about.help.h')}</h3>
    ${tel('999', 'about.help999.d', 'about.help999')}${tel('109', 'about.help109.d', 'about.help109')}
    <p class="note">${tr('about.credit', { area: areaName(), date: g ? g.meta.generated : '' })}</p>`;
}

/* ---------- events ---------- */
function onMapClick(ev) {
  if (S.state !== 'ready') return;
  const { lng, lat } = ev.latlng;
  if (S.mode === 'report') {
    if (map.getZoom() < 16) { zoomTo(ev.latlng, 17); toast(tr('rep.zoomIn')); return; }   // too coarse to pick one street
    const mpp = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** map.getZoom());
    const hit = G.snapEdge(g, lng, lat, Math.min(80, Math.max(20, 28 * mpp)));
    if (!hit) { toast(tr('rep.none')); return; }
    openReport(hit); return;
  }
  if (!S.origin) placePoint('o', lng, lat);
  else if (!S.dest) placePoint('d', lng, lat);
}

function bind() {
  $('#btn-lang').addEventListener('click', () => {
    S.lang = S.lang === 'bn' ? 'en' : 'bn'; pref.set('lang', S.lang);
    applyStatic(); render(); fillAbout();
    if ($('#dlg-mine').open) openMine();
  });
  $('#btn-about').addEventListener('click', () => { fillAbout(); $('#dlg-about').showModal(); });
  $('#banner').addEventListener('click', () => { fillAbout(); $('#dlg-about').showModal(); });
  $('#t-day').addEventListener('click', () => setTime(false));
  $('#t-night').addEventListener('click', () => setTime(true));
  bindField('o'); bindField('d');
  $('#btn-loc').addEventListener('click', useMyLocation);
  $('#btn-reset').addEventListener('click', reset);
  $('#btn-swap').addEventListener('click', swap);
  $('#btn-report').addEventListener('click', () => setMode(S.mode === 'report' ? 'plan' : 'report'));
  $('#btn-mine').addEventListener('click', openMine);
  $('#btn-export').addEventListener('click', exportReports);
  $('#btn-sheet').addEventListener('click', () => {
    const sh = $('#sheet'); sh.classList.toggle('collapsed');
    $('#btn-sheet').setAttribute('aria-expanded', String(!sh.classList.contains('collapsed')));
    render(); setTimeout(() => map && map.invalidateSize(), 50);
  });
  $('#routes').addEventListener('click', (ev) => {
    const b = ev.target.closest('.route-btn'); if (!b) return;
    S.selected = Number(b.dataset.i); drawRoutes(); renderRoutes(); fitRoutes();
  });
  $$('#dlg-report .kind').forEach((b) => b.addEventListener('click', () => saveReport(b.dataset.kind)));
  $$('#dlg-report [data-when]').forEach((b) => b.addEventListener('click', () => {
    $$('#dlg-report [data-when]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('#dlg-report').addEventListener('close', () => { hlLayer.clearLayers(); S.pending = null; });
  $('#mine-list').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-del]'); if (!b) return;
    R.removeReport(b.dataset.del); openMine(); applyReports(); toast(tr('rep.deleted'));
  });
  $('#ly-risk').addEventListener('change', (e) => { S.layers.risk = e.target.checked; paintNetwork(); render(); });
  $('#ly-police').addEventListener('change', (e) => toggleLayer('police', e.target.checked));
  $('#ly-hospital').addEventListener('change', (e) => toggleLayer('hospital', e.target.checked));
  window.addEventListener('resize', () => map && map.invalidateSize());
}

function toggleLayer(k, on) { S.layers[k] = on; if (on) poi[k].addTo(map); else poi[k].remove(); }

/* ---------- start ---------- */
function initMap() {
  const [w, s, e, n] = g.meta.bbox, bounds = L.latLngBounds([s, w], [n, e]);
  map = L.map('map', { zoomSnap: 0.5, zoomControl: false, attributionControl: false, minZoom: 13, maxZoom: 19, preferCanvas: true });
  const phone = window.matchMedia('(max-width: 899px)').matches;
  map.fitBounds(bounds, { paddingTopLeft: [10, 10], paddingBottomRight: [10, (phone ? $('#sheet').offsetHeight : 0) + 10], animate: false });
  tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, errorTileUrl: '' }).addTo(map);
  L.control.attribution({ position: 'topleft', prefix: false })
    .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>').addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.rectangle(bounds, { color: cssVar('--ink-3'), weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(map);

  canvas = L.canvas({ padding: 0.5 });
  const seen = new Set();
  for (const e of g.edges) {
    if (seen.has(e.key)) continue; seen.add(e.key);
    const line = L.polyline(e.pts.map((p) => [p[1], p[0]]), { renderer: canvas, interactive: false, color: cssVar('--base-net'), weight: 1.6, opacity: 0.75 }).addTo(map);
    baseLines.push({ line, e });
  }
  hlLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  reportLayer = L.layerGroup().addTo(map);
  for (const k of ['police', 'hospital']) {
    poi[k] = L.layerGroup((g.pois[k] || []).map((p) => L.marker([p[1], p[0]], {
      icon: mkIcon('', 26, `mk mk-${k}`), title: tr('layers.' + k), keyboard: false, interactive: false })));
  }
  if (S.layers.police) poi.police.addTo(map);
  map.on('click', onMapClick);
}

async function start() {
  applyStatic(); applyTheme(); bind(); render();
  try {
    const res = await fetch('data/area.json');
    if (!res.ok) throw new Error(res.status);
    g = G.buildGraph(await res.json());
  } catch (err) {
    console.error(err); S.state = 'failed'; render(); return;
  }
  sIndex = Q.buildIndex(g);
  R.loadReports();
  G.setOverrides(g, R.toOverrides(R.getReports(), g.meta.generated));
  initMap(); paintNetwork(); drawReports();
  S.state = 'ready'; render(); fillAbout();
  if (location.search.includes('debug')) window.__dsr = { map, S, g, G, R, Q, sIndex };   // test hook, off by default
  setTimeout(() => map.invalidateSize(), 100);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}
start();
