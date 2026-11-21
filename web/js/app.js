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
  commute: 'drive',                    // 'drive' | 'bus' | 'bike' | 'rickshaw' | 'walk'
  groups: [], selected: 0, error: null,
  layers: { risk: false, heatmap: true, traffic: true, police: true, hospital: false, metro: true },
  state: 'loading',                    // 'loading' | 'ready' | 'failed'
  locating: false, pending: null,      // pending: street hit while the report dialog is open
};
let g, map, tiles, canvas, routeLayer, reportLayer, hlLayer, cautionHeatLayer, metroLayer, trafficLayer;
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
  const pill = $('#route-count-pill');
  if (pill) pill.textContent = S.lang === 'bn' ? `${fmtNum('bn', S.groups.length)}টি বিকল্প পথ` : `${S.groups.length} Route Options`;

  S.groups.forEach((gr, i) => {
    const sel = i === S.selected, name = styleName(gr);
    const names = [...gr.names].sort((a, b) => NAME_ORDER.indexOf(b) - NAME_ORDER.indexOf(a)).map((n) => tr('route.' + n));
    const li = document.createElement('li');
    li.className = 'route' + (sel ? ' is-sel' : '');
    li.style.setProperty('--c', `var(${VAR[name]})`);
    const hi = pct(gr.high_risk_share);
    const score = Math.max(20, Math.min(99, Math.round((1 - gr.mean_risk) * 100)));
    const isSafest = gr.names.includes('safest');
    const badgeText = isSafest ? tr('route.recommended') : tr('route.estimate');
    const badgeCls = isSafest ? 'badge badge-safest' : 'badge';

    // Danger trend zone analysis along this specific route
    const crossedZones = (g && g.zones ? g.zones.filter(z => z.level >= 2 && gr.coords.some(c => G.distM(g, [z.lon, z.lat], c) <= (z.r_m || 800))) : []);
    const crossedHigh = crossedZones.filter(z => z.level >= 3);

    // Multi-modal commute calculations (Google & Apple Maps Grade)
    let commutePill = '';
    const distKm = gr.length_m / 1000;
    if (S.commute === 'drive') {
      const delayMin = Math.max(2, Math.round(distKm * (S.night ? 1.2 : 2.5)));
      const driveMin = Math.max(3, Math.round(distKm * 2.2 + delayMin));
      const fuelFare = Math.max(40, Math.round(distKm * 18));
      commutePill = `<span class="meta-pill">${fmtDist(gr.length_m)}</span>
                     <span class="meta-pill">~${S.lang === 'bn' ? fmtNum('bn', driveMin) : driveMin} min</span>
                     <span class="traffic-tag">+${S.lang === 'bn' ? fmtNum('bn', delayMin) : delayMin}m ${S.lang === 'bn' ? 'জ্যাম' : 'delay'}</span>
                     <span class="meta-pill">~${fuelFare} ৳</span>`;
    } else if (S.commute === 'bus') {
      const busMin = Math.max(6, Math.round(distKm * 3.8 + 8));
      const fareBus = Math.min(45, Math.max(20, Math.round(distKm * 3.5 + 10)));
      const lines = ['বিকাশ', 'অনাবিল', 'রাইদা', 'বিআরটিসি'][i % 4];
      commutePill = `<span class="meta-pill">${fmtDist(gr.length_m)}</span>
                     <span class="meta-pill">~${S.lang === 'bn' ? fmtNum('bn', busMin) : busMin} min</span>
                     <span class="bus-tag">${lines}</span>
                     <span class="meta-pill">${fareBus} ৳</span>`;
    } else if (S.commute === 'bike') {
      const bikeMin = Math.max(2, Math.round(distKm * 1.8 + 2));
      const bikeFare = Math.max(50, Math.round(distKm * 22 + 30));
      commutePill = `<span class="meta-pill">${fmtDist(gr.length_m)}</span>
                     <span class="meta-pill">~${S.lang === 'bn' ? fmtNum('bn', bikeMin) : bikeMin} min</span>
                     <span class="meta-pill">~${bikeFare} ৳ (Pathao/Uber)</span>`;
    } else if (S.commute === 'rickshaw') {
      if (gr.length_m < 3800) {
        const rMin = Math.max(3, Math.round(gr.length_m / 180));
        const fareMin = Math.max(30, Math.round(gr.length_m / 100) * 3);
        const fareMax = Math.max(50, Math.round(gr.length_m / 100) * 4.5);
        commutePill = `<span class="meta-pill">${fmtDist(gr.length_m)}</span>
                       <span class="meta-pill">~${S.lang === 'bn' ? fmtNum('bn', rMin) : rMin} min</span>
                       <span class="meta-pill">${fareMin}-${fareMax} ৳</span>`;
      } else {
        const cMin = Math.max(8, Math.round(gr.length_m / 350));
        const cFare = Math.max(160, Math.round(gr.length_m / 100) * 4);
        commutePill = `<span class="meta-pill">CNG: ~${S.lang === 'bn' ? fmtNum('bn', cMin) : cMin} min</span>
                       <span class="meta-pill">${cFare} ৳ (${S.lang === 'bn' ? 'মিটার/চুক্তি' : 'meter/contract'})</span>`;
      }
    } else {
      const steps = Math.round(gr.length_m * 1.35);
      commutePill = `<span class="meta-pill">${fmtDist(gr.length_m)}</span>
                     <span class="meta-pill">${tr('route.min', { n: minutes(gr.length_m) })}</span>
                     <span class="meta-pill">~${S.lang === 'bn' ? fmtNum('bn', steps) : steps} ${S.lang === 'bn' ? 'পা' : 'steps'}</span>`;
    }

    // Safety Alert & Danger Trend Notification
    let cautionNotice = '';
    if (crossedHigh.length > 0 || hi >= 20) {
      const zoneNames = crossedHigh.map(z => S.lang === 'bn' && z.name_bn ? z.name_bn : z.name).join(', ');
      cautionNotice = `<div class="route-caution-banner cb-danger">
        <svg class="cb-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div class="cb-content">
          <div class="cb-title"><strong>${S.lang === 'bn' ? 'টিয়ার ১: উচ্চ বিপদ ঝুঁকি অঞ্চল স্পর্শ করছে!' : 'Tier 1: High Danger Trend Detected!'}</strong></div>
          <div class="cb-desc">${S.lang === 'bn' ? `এই রুটটি ${zoneNames || 'কম আলোকিত গলি'}-এর নির্জন বা ছিনতাই ঝুঁকিপূর্ণ এলাকা স্পর্শ করে। একা চলাচলের ক্ষেত্রে রুট ১ বেছে নেওয়ার পরামর্শ দেওয়া হচ্ছে।` : `Passes near ${zoneNames || 'poorly-lit alleys'}. Switching to Route 1 is advised.`}</div>
          ${i !== 0 ? `<button type="button" class="btn-switch-safer" data-target-route="0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <span>${tr('route.switch_safer')}</span>
          </button>` : ''}
        </div>
      </div>`;
    } else if (crossedZones.length > 0 || hi > 5) {
      cautionNotice = `<div class="route-caution-banner cb-warn">
        <svg class="cb-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div class="cb-content">
          <div class="cb-title"><strong>${S.lang === 'bn' ? 'টিয়ার ২: মাঝারি সতর্কতা জোন' : 'Tier 2: Moderate Caution Zone'}</strong></div>
          <div class="cb-desc">${S.lang === 'bn' ? 'প্রধান সড়ক ধরে চলুন। গণপরিবহন বা রাইডশেয়ারের জন্য অপেক্ষার সময় সতর্ক থাকুন।' : 'Stay alert along major well-lit sections.'}</div>
        </div>
      </div>`;
    } else {
      cautionNotice = `<div class="route-caution-banner cb-safe">
        <svg class="cb-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <div class="cb-content">
          <div class="cb-title"><strong>${S.lang === 'bn' ? 'টিয়ার ৩: নিরাপদ ও যাচাইকৃত গ্রিন করিডোর' : 'Tier 3: Verified Safe Green Corridor'}</strong></div>
          <div class="cb-desc">${S.lang === 'bn' ? 'প্রধান আলোকিত এভিনিউ, সক্রিয় সিসিটিভি ক্যামেরা ও পুলিশ চেকপোস্ট সংলগ্ন। নারীদের জন্য সর্বোচ্চ নিরাপদ।' : 'Major illuminated avenue, CCTV surveillance & police presence.'}</div>
        </div>
      </div>`;
    }

    li.innerHTML = `
      <button type="button" class="route-btn" aria-pressed="${sel}" data-i="${i}">
        ${sampleSVG(name)}
        <span>
          <span class="route-name">${names.join(', ')}${gr.names.length > 1 ? ` <span class="route-same">(${tr('route.same')})</span>` : ''}</span>
          <span class="route-meta">
            ${commutePill}
            <span class="${badgeCls}">${badgeText}</span>
          </span>
        </span>
        <div class="safety-score-gauge">
          <span class="score-num" style="color:var(${VAR[name]});">${score}%</span>
          <span class="score-label">${S.lang === 'bn' ? 'স্কোর' : 'SCORE'}</span>
        </div>
      </button>
      ${sel ? `<div class="route-detail">
        ${cautionNotice}
        <div class="meter" role="img" aria-label="${tr('route.hiShare', { n: hi })}"><span style="width:${Math.max(2, hi)}%"></span></div>
        <div class="meter-label">${tr('route.hiShare', { n: hi })}</div>
        <p class="why">${tr('why')}</p>
        <ul class="reasons">${reasonsFor(gr).map((r) => `<li>${r}</li>`).join('')}</ul>
        <div class="route-actions-row">
          <button type="button" class="btn btn-primary btn-start-walk" data-walk-idx="${i}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>${S.commute === 'walk' ? tr('nav.start_walk') : (S.lang === 'bn' ? 'লাইভ নেভিগেশন শুরু' : 'Start Navigation')}</span>
          </button>
          <button type="button" class="btn-share-mini" data-share-idx="${i}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            <span>${tr('route.share')}</span>
          </button>
        </div>
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
    line.setStyle(S.layers.risk ? { color: ramp[cls(risk[e.i])], weight: 3.5, opacity: 0.92 }
                                : { color: base, weight: 1, opacity: 0 });
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

function drawCautionHeatmap() {
  if (!cautionHeatLayer) return;
  cautionHeatLayer.clearLayers();
  if (!g || !g.zones) return;
  for (const z of g.zones) {
    const isHigh = z.level >= 3;
    const isMod = z.level === 2;
    const strokeColor = isHigh ? '#e11d48' : (isMod ? '#d97706' : '#059669');
    const fillColor = isHigh ? '#f43f5e' : (isMod ? '#f59e0b' : '#10b981');
    const badgeCls = isHigh ? 'cb-level-high' : (isMod ? 'cb-level-mod' : 'cb-level-safe');
    const badgeText = isHigh ? (S.lang === 'bn' ? 'উচ্চ সতর্কতা জোন' : 'High Caution Zone') :
                      (isMod ? (S.lang === 'bn' ? 'মাঝারি সতর্কতা' : 'Moderate Caution') :
                               (S.lang === 'bn' ? 'নিরাপদ করিডোর' : 'Safe Corridor'));
    const badgePillCls = isHigh ? 'cp-badge-danger' : (isMod ? 'cp-badge-warn' : 'cp-badge-safe');
    const name = S.lang === 'bn' && z.name_bn ? z.name_bn : z.name;
    const ico = isHigh
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="17" r="1" fill="#fff"/></svg>'
      : (isMod
          ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><circle cx="12" cy="7" r="1" fill="#fff"/><line x1="12" y1="11" x2="12" y2="17"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>');

    const circle = L.circle([z.lat, z.lon], {
      radius: z.r_m || 800,
      color: strokeColor,
      weight: 1.8,
      dashArray: isHigh ? '5,5' : null,
      fillColor: fillColor,
      fillOpacity: isHigh ? 0.22 : (isMod ? 0.17 : 0.14),
      interactive: true,
    });

    const marker = L.marker([z.lat, z.lon], {
      icon: L.divIcon({
        className: 'caution-div-icon',
        html: `<div class="caution-badge ${badgeCls}" title="${name}">${ico}</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
      interactive: true,
    });

    const popupContent = `
      <div class="cp-card">
        <div class="cp-header">
          <h4 class="cp-title">${name}</h4>
          <span class="cp-badge ${badgePillCls}">${badgeText}</span>
        </div>
        <p class="cp-desc">${z.caution}</p>
        <div class="cp-tip ${!isHigh && !isMod ? 'tip-safe' : ''}">
          <strong>${S.lang === 'bn' ? 'নিরাপত্তা পরামর্শ:' : 'Safety Tip:'}</strong> ${z.tip}
        </div>
      </div>
    `;

    circle.bindPopup(popupContent, { className: 'caution-popup' });
    marker.bindPopup(popupContent, { className: 'caution-popup' });

    circle.addTo(cautionHeatLayer);
    marker.addTo(cautionHeatLayer);
  }
}

function drawMetroStations() {
  if (!metroLayer) return;
  metroLayer.clearLayers();
  if (!g || !g.pois || !g.pois.metro) return;
  for (const st of g.pois.metro) {
    const name = S.lang === 'bn' && st.name_bn ? st.name_bn : st.name;
    const [lon, lat] = st.ll;
    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'metro-div-icon',
        html: `<div class="metro-marker" title="${name}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="15" rx="2"/><line x1="4" y1="11" x2="20" y2="11"/><circle cx="8" cy="15" r="1"/><circle cx="16" cy="15" r="1"/><path d="m5 18-2 3"/><path d="m19 18 2 3"/></svg></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
      interactive: true,
    });

    const popupHtml = `
      <div class="mp-card">
        <div class="mp-header">
          <span class="mp-icon" style="display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:50%; background:linear-gradient(135deg, #0284c7, #0369a1); color:#fff;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="15" rx="2"/><line x1="4" y1="11" x2="20" y2="11"/><circle cx="8" cy="15" r="1"/><circle cx="16" cy="15" r="1"/><path d="m5 18-2 3"/><path d="m19 18 2 3"/></svg></span>
          <div>
            <h4 class="mp-title">${name}</h4>
            <span class="mp-tag">${S.lang === 'bn' ? 'মেট্রোরেল লাইন ৬ স্টেশন' : 'MRT Line-6 Station'}</span>
          </div>
        </div>
        <div class="mp-details">
          ${S.lang === 'bn' ? 'ডেডিকেটেড নারী কামরা, সিসিটিভি নজরদারি ও সার্বক্ষণিক নিরাপত্তা কর্মী বিদ্যমান।' : 'Dedicated Women\'s Coach, CCTV surveillance & security personnel.'}
        </div>
        <button type="button" class="btn-route-to" data-st-lon="${lon}" data-st-lat="${lat}" data-st-name="${name}">
          <span>${S.lang === 'bn' ? 'এখানে নিরাপদ পথ দেখুন' : 'Get Safe Route Here'}</span>
        </button>
      </div>
    `;

    marker.bindPopup(popupHtml, { className: 'metro-popup' });
    marker.on('popupopen', () => {
      const btn = document.querySelector(`.btn-route-to[data-st-name="${name}"]`);
      if (btn) {
        btn.addEventListener('click', () => {
          placePoint('d', lon, lat, { kind: 'street', name: `${name} (Metro)` });
          map.closePopup();
          toast(S.lang === 'bn' ? `গন্তব্য সেট হয়েছে: ${name}` : `Destination set: ${name}`);
        });
      }
    });

    marker.addTo(metroLayer);
  }
}

const TRAFFIC_CORRIDORS = [
  // Airport Road & Pragati Sarani (heavy jam)
  { name: 'Airport Rd / Pragati Sarani', name_bn: 'এয়ারপোর্ট রোড ও প্রগতি সরণি',
    pts: [[90.400, 23.832], [90.408, 23.815], [90.418, 23.798], [90.426, 23.775]],
    status: 'heavy', speed: 8, delay: 18 },
  // Mirpur Road (slow)
  { name: 'Mirpur Road', name_bn: 'মিরপুর রোড (গাবতলী-সায়েন্সল্যাব)',
    pts: [[90.355, 23.790], [90.368, 23.772], [90.378, 23.754], [90.384, 23.738]],
    status: 'slow', speed: 18, delay: 9 },
  // Begum Rokeya Sarani (fast/moderate)
  { name: 'Begum Rokeya Sarani', name_bn: 'বেগম রোকেয়া সরণি (মেট্রোরেল করিডোর)',
    pts: [[90.370, 23.805], [90.375, 23.785], [90.382, 23.765]],
    status: 'fast', speed: 38, delay: 2 },
  // Mohakhali & Jahangir Gate (heavy)
  { name: 'Mohakhali / Jahangir Gate', name_bn: 'মহাখালী ও জাহাঙ্গীর গেট করিডোর',
    pts: [[90.405, 23.790], [90.398, 23.775], [90.390, 23.760]],
    status: 'heavy', speed: 9, delay: 15 },
  // Kazi Nazrul Islam Ave (heavy)
  { name: 'Kazi Nazrul Islam Ave', name_bn: 'কাজী নজরুল ইসলাম এভিনিউ (ফার্মগেট-শাহবাগ)',
    pts: [[90.390, 23.760], [90.393, 23.748], [90.396, 23.738]],
    status: 'heavy', speed: 7, delay: 14 },
  // Gulshan Avenue (moderate)
  { name: 'Gulshan Avenue', name_bn: 'গুলশান এভিনিউ',
    pts: [[90.413, 23.778], [90.418, 23.792], [90.415, 23.805]],
    status: 'slow', speed: 20, delay: 6 },
  // Hatirjheel Loop (fast)
  { name: 'Hatirjheel Loop Expressway', name_bn: 'হাতিরঝিল এক্সপ্রেসওয়ে',
    pts: [[90.398, 23.768], [90.410, 23.772], [90.420, 23.767]],
    status: 'fast', speed: 45, delay: 1 },
  // Panthapath & Green Road (moderate)
  { name: 'Panthapath Road', name_bn: 'পান্থপথ (বসুন্ধরা সিটি সংলগ্ন)',
    pts: [[90.380, 23.752], [90.390, 23.751]],
    status: 'slow', speed: 16, delay: 8 }
];

function drawTraffic() {
  if (!trafficLayer) return;
  trafficLayer.clearLayers();
  for (const c of TRAFFIC_CORRIDORS) {
    const isHeavy = c.status === 'heavy';
    const isSlow = c.status === 'slow';
    const color = isHeavy ? '#dc2626' : (isSlow ? '#f59e0b' : '#10b981');
    const glow = isHeavy ? 'rgba(220, 38, 38, 0.45)' : (isSlow ? 'rgba(245, 158, 11, 0.45)' : 'rgba(16, 185, 129, 0.45)');
    const statusText = isHeavy ? (S.lang === 'bn' ? 'তীব্র যানজট' : 'Heavy Traffic') :
                       (isSlow ? (S.lang === 'bn' ? 'ধীরগতি' : 'Slow Traffic') :
                                 (S.lang === 'bn' ? 'স্বাভাবিক গতি' : 'Fast Flow'));
    const name = S.lang === 'bn' ? c.name_bn : c.name;
    const ll = c.pts.map(p => [p[1], p[0]]);

    L.polyline(ll, { color: glow, weight: 8, opacity: 0.6, interactive: false, lineCap: 'round' }).addTo(trafficLayer);

    const line = L.polyline(ll, {
      color: color,
      weight: 4.5,
      opacity: 0.95,
      interactive: true,
      lineCap: 'round',
      dashArray: isSlow ? '10, 4' : null,
    }).addTo(trafficLayer);

    const popupHtml = `
      <div class="traffic-popup-card">
        <div class="tf-header">
          <span class="tf-dot ${isHeavy ? 'tf-heavy' : (isSlow ? 'tf-slow' : 'tf-fast')}"></span>
          <strong>${name}</strong>
        </div>
        <div class="tf-meta">
          <span><strong>${statusText}</strong></span>
          <span>${S.lang === 'bn' ? 'গতি' : 'Speed'}: ~${S.lang === 'bn' ? fmtNum('bn', c.speed) : c.speed} km/h</span>
          ${c.delay > 0 ? `<span class="tf-delay">+${S.lang === 'bn' ? fmtNum('bn', c.delay) : c.delay} min ${S.lang === 'bn' ? 'বিলম্ব' : 'delay'}</span>` : ''}
        </div>
      </div>
    `;
    line.bindPopup(popupHtml, { className: 'traffic-popup' });
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
  const sheet = $('#sheet');
  if (S.origin && S.dest) {
    const res = G.routeOptions(g, S.origin.node, S.dest.node, S.night);
    if (res.error) {
      S.groups = [];
      S.error = res.error;
      if (sheet) sheet.classList.remove('has-routes');
    } else {
      S.groups = res.groups;
      S.selected = 0;
      if (sheet) {
        sheet.classList.add('has-routes');
        sheet.classList.remove('collapsed');
      }
    }
  } else {
    S.groups = [];
    if (sheet) sheet.classList.remove('has-routes');
  }
  drawRoutes(); render();
  if (fit && S.groups.length) {
    fitRoutes();
    const box = $('#routes-box');
    if (box && window.matchMedia('(max-width: 899px)').matches) {
      setTimeout(() => {
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
    }
  }
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
  const sheet = $('#sheet');
  if (sheet) sheet.classList.remove('has-routes', 'expanded');
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

/* ---------- sharing ---------- */
function shareRouteSummary(gr) {
  const targetGr = gr || (S.groups && S.groups[S.selected]);
  const oName = S.origin ? pointLabel(S.origin) : (S.lang === 'bn' ? 'শুরুর স্থান' : 'Start location');
  const dName = S.dest ? pointLabel(S.dest) : (S.lang === 'bn' ? 'গন্তব্য স্থান' : 'Destination');
  const dist = targetGr ? fmtDist(targetGr.length_m) : '';
  const time = targetGr ? tr('route.min', { n: minutes(targetGr.length_m) }) : '';
  const score = targetGr ? Math.max(20, Math.min(99, Math.round((1 - targetGr.mean_risk) * 100))) : 85;
  const text = `${S.lang === 'bn' ? 'পথিকা নিরাপদ পথ' : 'Pothika Safe Routes'}:\n${S.lang === 'bn' ? 'শুরু' : 'From'}: ${oName}\n${S.lang === 'bn' ? 'গন্তব্য' : 'To'}: ${dName}\n${S.lang === 'bn' ? 'দূরত্ব' : 'Distance'}: ${dist} (~${time})\n${S.lang === 'bn' ? 'নিরাপত্তা স্কোর' : 'Safety Score'}: ${score}%\n\n${S.lang === 'bn' ? 'ঢাকার রাস্তায় নারীদের নিরাপদ চলাচলের জন্য পথিকা (Pothika) ব্যবহার করছি।' : 'Using Pothika Safe Routes for secure women navigation in Dhaka.'}`;

  if (navigator.share) {
    navigator.share({ title: 'Pothika Safe Walking Route', text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast(tr('sos.copied')));
  } else {
    toast(tr('sos.copied'));
  }
}

/* ---------- live safe walk & safety tools ---------- */
let fakeCallTimer = null, callSec = 0;

function startSafeWalk(gr) {
  const g = gr || (S.groups && S.groups[S.selected]);
  if (!g) return;
  const oName = S.origin ? pointLabel(S.origin) : 'Dhaka';
  const dName = S.dest ? pointLabel(S.dest) : 'Destination';
  const hud = $('#walk-hud');
  if (hud) {
    hud.hidden = false;
    const details = $('#walk-hud-details');
    if (details) {
      details.textContent = `${oName} → ${dName} • ${fmtDist(g.length_m)} (~${tr('route.min', { n: minutes(g.length_m) })})`;
    }
    $('#sheet').classList.add('collapsed');
    toast(tr('nav.live_heading'));
    fitRoutes();
  }
}

function endSafeWalk() {
  const hud = $('#walk-hud');
  if (hud) hud.hidden = true;
  $('#sheet').classList.remove('collapsed');
  toast(S.lang === 'bn' ? 'ধন্যবাদ! আপনি নিরাপদে গন্তব্যে পৌঁছেছেন।' : 'Trip complete! You have arrived safely.');
}

function openFakeCall() {
  const dlg = $('#dlg-fake-call');
  if (!dlg) return;
  $('#fake-call-active-ui').hidden = true;
  $('#fake-call-actions').hidden = false;
  $('#fake-call-status').textContent = tr('nav.fake_ringing');
  clearInterval(fakeCallTimer);
  callSec = 0;
  dlg.showModal();
}

function acceptFakeCall() {
  $('#fake-call-actions').hidden = true;
  $('#fake-call-active-ui').hidden = false;
  $('#fake-call-status').textContent = tr('nav.fake_connected');
  callSec = 0;
  clearInterval(fakeCallTimer);
  fakeCallTimer = setInterval(() => {
    callSec++;
    const m = String(Math.floor(callSec / 60)).padStart(2, '0');
    const s = String(callSec % 60).padStart(2, '0');
    const el = $('#call-timer');
    if (el) el.textContent = `${m}:${s}`;
  }, 1000);
}

function closeFakeCall() {
  clearInterval(fakeCallTimer);
  const dlg = $('#dlg-fake-call');
  if (dlg && dlg.open) dlg.close();
}

function bind() {
  const sosBtn = $('#btn-sos');
  if (sosBtn) sosBtn.addEventListener('click', () => $('#dlg-sos').showModal());
  const fabSos = $('#fab-sos');
  if (fabSos) fabSos.addEventListener('click', () => $('#dlg-sos').showModal());
  const hudSos = $('#btn-hud-sos');
  if (hudSos) hudSos.addEventListener('click', () => $('#dlg-sos').showModal());

  // Commute mode switcher (Google & Apple Maps 5-mode system)
  $$('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.mode-tab').forEach((t) => {
        t.classList.toggle('is-active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      S.commute = tab.dataset.commute;
      renderRoutes();
      const modeNames = {
        drive: S.lang === 'bn' ? 'গাড়ি (Drive)' : 'Drive (Car)',
        bus: S.lang === 'bn' ? 'বাস ও গণপরিবহন' : 'Bus & Transit',
        bike: S.lang === 'bn' ? 'বাইক / রাইড' : 'Bike / Ride',
        rickshaw: S.lang === 'bn' ? 'রিকশা / সিএনজি' : 'Rickshaw / CNG',
        walk: S.lang === 'bn' ? 'হাঁটা (Walk)' : 'Walk',
      };
      toast(modeNames[S.commute] || S.commute);
    });
  });

  const fabTraffic = $('#fab-traffic');
  if (fabTraffic) {
    fabTraffic.addEventListener('click', () => {
      const cur = S.layers.traffic;
      const next = !cur;
      toggleLayer('traffic', next);
      fabTraffic.classList.toggle('is-active', next);
      const chk = $('#ly-traffic');
      if (chk) chk.checked = next;
      toast(next ? (S.lang === 'bn' ? 'লাইভ ট্রাফিক লেয়ার সক্রিয়' : 'Live Traffic Flow Activated') : (S.lang === 'bn' ? 'ট্রাফিক লেয়ার বন্ধ' : 'Traffic Layer Disabled'));
    });
  }

  const fabHeatmap = $('#fab-heatmap');
  if (fabHeatmap) {
    fabHeatmap.addEventListener('click', () => {
      const cur = S.layers.heatmap;
      const next = !cur;
      toggleLayer('heatmap', next);
      fabHeatmap.classList.toggle('is-active', next);
      const chk = $('#ly-caution-heatmap');
      if (chk) chk.checked = next;
      toast(next ? (S.lang === 'bn' ? 'মহিলাদের সতর্কতা হিটম্যাপ সক্রিয়' : 'Women\'s Caution Heatmap Activated') : (S.lang === 'bn' ? 'সতর্কতা হিটম্যাপ বন্ধ' : 'Caution Heatmap Disabled'));
    });
  }

  const fabMetro = $('#fab-metro');
  if (fabMetro) {
    fabMetro.addEventListener('click', () => {
      const cur = S.layers.metro;
      const next = !cur;
      toggleLayer('metro', next);
      fabMetro.classList.toggle('is-active', next);
      const chk = $('#ly-metro');
      if (chk) chk.checked = next;
      toast(next ? (S.lang === 'bn' ? 'মেট্রোরেল স্টেশনসমূহ দৃশ্যমান' : 'Metro Stations Shown') : (S.lang === 'bn' ? 'মেট্রোরেল লুকানো হয়েছে' : 'Metro Stations Hidden'));
    });
  }

  const fabLoc = $('#fab-loc');
  if (fabLoc) fabLoc.addEventListener('click', useMyLocation);

  // 1-Tap Quick Explore Cards
  $$('.explore-card').forEach((card) => {
    card.addEventListener('click', () => {
      const dName = card.dataset.destName;
      const sName = card.dataset.startName;
      const dRes = Q.search(sIndex, dName, 1);
      const sRes = Q.search(sIndex, sName, 1);

      if (dRes.length) {
        if (!S.origin && sRes.length) {
          placePoint('o', sRes[0].lon, sRes[0].lat, { kind: 'street', name: sRes[0].name });
        }
        pickResult('d', dRes[0]);
        toast(S.lang === 'bn' ? `নিরাপদ পথ গণনা হচ্ছে: ${card.dataset.destLabel || dName}` : `Routing to: ${dName}`);
      } else {
        toast(dName);
      }
    });
  });

  // Live Safe Walk HUD buttons
  const endWalkBtn = $('#btn-end-walk');
  if (endWalkBtn) endWalkBtn.addEventListener('click', endSafeWalk);
  const hudFakeCall = $('#btn-hud-fakecall');
  if (hudFakeCall) hudFakeCall.addEventListener('click', openFakeCall);
  const hudShare = $('#btn-hud-share');
  if (hudShare) hudShare.addEventListener('click', () => shareRouteSummary());

  // Fake Call buttons
  const callAccept = $('#btn-call-accept');
  if (callAccept) callAccept.addEventListener('click', acceptFakeCall);
  const callDecline = $('#btn-call-decline');
  if (callDecline) callDecline.addEventListener('click', closeFakeCall);
  const callHangup = $('#btn-call-hangup');
  if (callHangup) callHangup.addEventListener('click', closeFakeCall);

  const shareFullBtn = $('#btn-share-route');
  if (shareFullBtn) shareFullBtn.addEventListener('click', () => shareRouteSummary());

  $$('.preset-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.preset;
      const res = Q.search(sIndex, q, 1);
      if (res.length) {
        pickResult(S.origin ? 'd' : 'o', res[0]);
      } else {
        toast(q);
      }
    });
  });

  $('#btn-lang').addEventListener('click', () => {
    S.lang = S.lang === 'bn' ? 'en' : 'bn'; pref.set('lang', S.lang);
    applyStatic(); render(); fillAbout();
    drawCautionHeatmap(); drawMetroStations(); drawTraffic();
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
  const sh = $('#sheet');
  const btnSh = $('#btn-sheet');
  if (btnSh && sh) {
    let startY = 0, startTime = 0;
    btnSh.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
      startTime = Date.now();
    }, { passive: true });

    btnSh.addEventListener('touchend', (e) => {
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dy) > 25) {
        if (dy < 0) {
          // Swiped UP -> expand fully upward
          sh.classList.remove('collapsed');
          sh.classList.add('expanded');
        } else {
          // Swiped DOWN -> collapse
          if (sh.classList.contains('expanded')) {
            sh.classList.remove('expanded');
          } else {
            sh.classList.add('collapsed');
          }
        }
        btnSh.setAttribute('aria-expanded', String(!sh.classList.contains('collapsed')));
        render();
        setTimeout(() => map && map.invalidateSize(), 60);
      }
    }, { passive: true });

    btnSh.addEventListener('click', (e) => {
      if (Date.now() - startTime < 250 && Math.abs(e.clientY - startY) > 15) return;
      if (sh.classList.contains('collapsed')) {
        sh.classList.remove('collapsed');
        sh.classList.add('expanded');
      } else if (sh.classList.contains('expanded')) {
        sh.classList.remove('expanded');
      } else {
        sh.classList.add('expanded');
      }
      btnSh.setAttribute('aria-expanded', String(!sh.classList.contains('collapsed')));
      render();
      setTimeout(() => map && map.invalidateSize(), 60);
    });

    const plannerCard = $('.planner-card');
    if (plannerCard) {
      let pcStartY = 0;
      plannerCard.addEventListener('touchstart', (e) => {
        pcStartY = e.touches[0].clientY;
      }, { passive: true });

      plannerCard.addEventListener('touchend', (e) => {
        const dy = e.changedTouches[0].clientY - pcStartY;
        const body = $('#sheet-body');
        if (dy < -40 && !sh.classList.contains('expanded')) {
          sh.classList.remove('collapsed');
          sh.classList.add('expanded');
          btnSh.setAttribute('aria-expanded', 'true');
          render();
          setTimeout(() => map && map.invalidateSize(), 60);
        } else if (dy > 40 && body && body.scrollTop <= 5 && sh.classList.contains('expanded')) {
          sh.classList.remove('expanded');
          btnSh.setAttribute('aria-expanded', 'true');
          render();
          setTimeout(() => map && map.invalidateSize(), 60);
        }
      }, { passive: true });
    }
  }
  $('#routes').addEventListener('click', (ev) => {
    const sw = ev.target.closest('.btn-switch-safer');
    if (sw) {
      S.selected = 0;
      drawRoutes(); renderRoutes(); fitRoutes();
      toast(S.lang === 'bn' ? 'নিরাপদ রুট ১ নির্বাচিত হয়েছে' : 'Switched to Safest Route 1');
      return;
    }
    const wb = ev.target.closest('[data-walk-idx]');
    if (wb) {
      const idx = Number(wb.dataset.walkIdx);
      S.selected = idx;
      drawRoutes(); renderRoutes();
      startSafeWalk(S.groups[idx]);
      return;
    }
    const sb = ev.target.closest('[data-share-idx]');
    if (sb) {
      const idx = Number(sb.dataset.shareIdx);
      shareRouteSummary(S.groups[idx]);
      return;
    }
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
  const chkTraffic = $('#ly-traffic');
  if (chkTraffic) {
    chkTraffic.addEventListener('change', (e) => {
      toggleLayer('traffic', e.target.checked);
      const fab = $('#fab-traffic');
      if (fab) fab.classList.toggle('is-active', e.target.checked);
    });
  }
  const chkCaution = $('#ly-caution-heatmap');
  if (chkCaution) {
    chkCaution.addEventListener('change', (e) => {
      toggleLayer('heatmap', e.target.checked);
      const fab = $('#fab-heatmap');
      if (fab) fab.classList.toggle('is-active', e.target.checked);
    });
  }
  const chkMetro = $('#ly-metro');
  if (chkMetro) {
    chkMetro.addEventListener('change', (e) => {
      toggleLayer('metro', e.target.checked);
      const fab = $('#fab-metro');
      if (fab) fab.classList.toggle('is-active', e.target.checked);
    });
  }
  $('#ly-police').addEventListener('change', (e) => toggleLayer('police', e.target.checked));
  $('#ly-hospital').addEventListener('change', (e) => toggleLayer('hospital', e.target.checked));
  window.addEventListener('resize', () => map && map.invalidateSize());
}

function toggleLayer(k, on) {
  S.layers[k] = on;
  if (k === 'heatmap') {
    if (on) cautionHeatLayer.addTo(map); else cautionHeatLayer.remove();
  } else if (k === 'metro') {
    if (on) metroLayer.addTo(map); else metroLayer.remove();
  } else if (k === 'traffic') {
    if (on) trafficLayer.addTo(map); else trafficLayer.remove();
  } else {
    if (on) poi[k].addTo(map); else poi[k].remove();
  }
}

/* ---------- start ---------- */
function initMap() {
  const [w, s, e, n] = g.meta.bbox, bounds = L.latLngBounds([s, w], [n, e]);
  map = L.map('map', { zoomSnap: 0.5, zoomControl: false, attributionControl: false, minZoom: 13, maxZoom: 19, preferCanvas: true });
  const phone = window.matchMedia('(max-width: 899px)').matches;
  map.fitBounds(bounds, { paddingTopLeft: [10, 10], paddingBottomRight: [10, (phone ? $('#sheet').offsetHeight : 0) + 10], animate: false });
  tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, errorTileUrl: '' }).addTo(map);
  L.control.attribution({ position: 'bottomleft', prefix: false })
    .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>').addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.rectangle(bounds, { color: cssVar('--ink-3'), weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(map);

  canvas = L.canvas({ padding: 0.5 });
  const seen = new Set();
  for (const e of g.edges) {
    if (seen.has(e.key)) continue; seen.add(e.key);
    const line = L.polyline(e.pts.map((p) => [p[1], p[0]]), { renderer: canvas, interactive: false, color: cssVar('--base-net'), weight: 1.2, opacity: 0 }).addTo(map);
    baseLines.push({ line, e });
  }
  hlLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  reportLayer = L.layerGroup().addTo(map);
  cautionHeatLayer = L.layerGroup().addTo(map);
  metroLayer = L.layerGroup().addTo(map);
  trafficLayer = L.layerGroup().addTo(map);

  drawCautionHeatmap();
  drawMetroStations();
  drawTraffic();

  for (const k of ['police', 'hospital']) {
    poi[k] = L.layerGroup((g.pois[k] || []).map((p) => L.marker([p[1], p[0]], {
      icon: mkIcon('', 26, `mk mk-${k}`), title: tr('layers.' + k), keyboard: false, interactive: false })));
  }
  if (S.layers.police) poi.police.addTo(map);
  if (!S.layers.traffic) trafficLayer.remove();
  if (!S.layers.heatmap) cautionHeatLayer.remove();
  if (!S.layers.metro) metroLayer.remove();
  map.on('click', onMapClick);
}

async function start() {
  applyStatic(); applyTheme(); bind(); render();
  try {
    const res = await fetch('data/area.json?v=12');
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
