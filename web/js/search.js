// Offline street-name search over the bundled map data. Nothing typed here leaves the device.
// Only named streets inside the mapped area can be found; about half of the streets have no name in OpenStreetMap.
const KLAT = 110574;                 // metres per degree of latitude (same constant as graph.js)
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const SECTORS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

/** Lower-case, Bangla digits to ASCII, "সড়ক/রোড" to "road", "এভিনিউ" to "avenue", drop "No." and punctuation. */
const nfc = (list) => new RegExp(list.map((x) => x.normalize('NFC')).join('|'), 'g');
const ROAD_BN = nfc(['সড়ক', 'রোড', 'রাস্তা']), AVENUE_BN = nfc(['অ্যাভিনিউ', 'এভিনিউ']);   // NFC: ড় can be one letter or ড + nukta

export function norm(s) {
  return String(s ?? '').normalize('NFC').toLowerCase()
    .replace(/[০-৯]/g, (d) => BN_DIGITS.indexOf(d))
    .replace(ROAD_BN, ' road ')
    .replace(AVENUE_BN, ' avenue ')
    .replace(/\bno\b\.?|নং/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim().replace(/\s+/g, ' ');
}

function compass(g, lon, lat) {
  const [w, s, e, n] = g.meta.bbox, cx = (w + e) / 2, cy = (s + n) / 2;
  const dx = (lon - cx) * g.kx, dy = (lat - cy) * KLAT;
  const halfW = ((e - w) * g.kx) / 2, halfH = ((n - s) * KLAT) / 2;
  if (Math.hypot(dx, dy) < 0.2 * Math.max(halfW, halfH)) return 'c';
  const ang = (Math.atan2(dx, dy) * 180) / Math.PI;          // 0 = north, clockwise
  return SECTORS[Math.round(((ang + 360) % 360) / 45) % 8];
}

/** One item per connected piece of a named street, so two different "Road 3" are two results. */
export function buildIndex(g) {
  const seen = new Set(), byName = new Map();
  for (const e of g.edges) {
    if (!e.name || seen.has(e.key)) continue;
    seen.add(e.key);
    const k = norm(e.name); if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(e);
  }
  const items = [];
  for (const [key, list] of byName) {
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const e of list) for (const n of [e.u, e.v]) if (!parent.has(n)) parent.set(n, n);
    for (const e of list) parent.set(find(e.u), find(e.v));
    const comps = new Map();
    for (const e of list) { const r = find(e.u); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(e); }
    for (const es of comps.values()) {
      const nodes = new Set(); let len = 0, sx = 0, sy = 0;
      for (const e of es) {
        nodes.add(e.u); nodes.add(e.v); len += e.len;
        const a = e.pts[0], b = e.pts[e.pts.length - 1]; sx += (a[0] + b[0]) / 2; sy += (a[1] + b[1]) / 2;
      }
      const cx = sx / es.length, cy = sy / es.length;
      let best = null, bd = Infinity;
      for (const n of nodes) {
        const p = g.nodes[n], d = Math.hypot((p[0] - cx) * g.kx, (p[1] - cy) * KLAT);
        if (d < bd) { bd = d; best = p; }
      }
      items.push({ name: es[0].name, key, tokens: key.split(' '), lon: best[0], lat: best[1],
                   len_m: Math.round(len), dir: compass(g, best[0], best[1]) });
    }
  }
  return items;
}

export function search(items, query, limit = 6) {
  const nq = norm(query); if (!nq) return [];
  const qt = nq.split(' '), out = [];
  for (const it of items) {
    let s;
    if (it.key === nq) s = 100;
    else if (it.key.startsWith(nq)) s = 70;
    else {
      s = 0;
      for (const q of qt) {
        if (it.tokens.includes(q)) s += 10;
        else if (it.tokens.some((x) => x.startsWith(q))) s += 5;
        else { s = -1; break; }
      }
      if (s < 0) continue;
    }
    out.push([s + Math.min(it.len_m, 2000) / 2000, it]);      // longer streets first among equals
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
}
