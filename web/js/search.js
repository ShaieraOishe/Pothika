// Offline street-name search over the bundled map data. Nothing typed here leaves the device.
// Only named streets inside the mapped area can be found; about half of the streets have no name in OpenStreetMap.
const KLAT = 110574;                 // metres per degree of latitude (same constant as graph.js)
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const SECTORS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

/** Lower-case, Bangla digits to ASCII, "সড়ক/রোড" to "road", "এভিনিউ" to "avenue", drop "No." and punctuation. */
const nfc = (list) => new RegExp(list.map((x) => x.normalize('NFC')).join('|'), 'g');
const ROAD_BN = nfc(['সড়ক', 'রোড', 'রাস্তা']), AVENUE_BN = nfc(['অ্যাভিনিউ', 'এভিনিউ']);   // NFC: ড় can be one letter or ড + nukta

const DHAKA_ALIASES = [
  [/ধানমন্ডি/g, 'dhanmondi'],
  [/গুলশান/g, 'gulshan'],
  [/বনানী/g, 'banani'],
  [/মিরপুর/g, 'mirpur'],
  [/উত্তরা/g, 'uttara'],
  [/শাহবাগ/g, 'shahbag'],
  [/ফার্মগেট/g, 'farmgate'],
  [/পান্থপথ/g, 'panthapath'],
  [/হাতিরঝিল/g, 'hatirjheel'],
  [/মোহাম্মদপুর/g, 'mohammadpur'],
  [/তেজগাঁও/g, 'tejgaon'],
  [/মতিঝিল/g, 'motijheel'],
  [/বাড্ডা/g, 'badda'],
  [/রামপুরা/g, 'rampura'],
  [/খিলগাঁও/g, 'khilgaon'],
  [/লালবাগ/g, 'lalbagh'],
  [/সদরঘাট/g, 'sadarghat'],
  [/পুরান\s*ঢাকা/g, 'old dhaka'],
  [/এয়ারপোর্ট/g, 'airport'],
  [/সেক্টর/g, 'sector'],
  [/রোকেয়া/g, 'rokeya'],
  [/সরণি|স্মরণী/g, 'sarani'],
  [/বিজয়/g, 'bijoy'],
  [/মানিক\s*মিয়া/g, 'manik mia'],
  [/প্রগতি/g, 'pragati'],
  [/এলিফ্যান্ট/g, 'elephant'],
  [/গ্রিন/g, 'green'],
  [/বসুন্ধরা/g, 'bashundhara'],
  [/যমুনা/g, 'jamuna'],
  [/এভারকেয়ার|অ্যাপোলো/g, 'evercare'],
  [/লেক/g, 'lake'],
  [/টিএসসি/g, 'tsc'],
  [/বিশ্ববিদ্যালয়/g, 'university'],
  [/হাসপাতাল/g, 'hospital'],
  [/সিটি/g, 'city'],
  [/ব্লক/g, 'block'],
];

export function norm(s) {
  let str = String(s ?? '').normalize('NFC').toLowerCase()
    .replace(/[০-৯]/g, (d) => BN_DIGITS.indexOf(d))
    .replace(ROAD_BN, ' road ')
    .replace(AVENUE_BN, ' avenue ')
    .replace(/\bno\b\.?|নং/g, ' ');

  for (const [pattern, replacement] of DHAKA_ALIASES) {
    str = str.replace(pattern, ` ${replacement} `);
  }

  return str
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

  // Also index Popular Areas, Zones, and Neighborhoods (e.g. Bashundhara R/A, Dhanmondi, Gulshan)
  if (g.zones) {
    for (const z of g.zones) {
      const cleanName = z.name_bn ? `${z.name} (${z.name_bn})` : z.name;
      const k = norm(z.name);
      if (!k) continue;
      let best = null, bd = Infinity;
      for (let n = 0; n < g.nodes.length; n++) {
        const p = g.nodes[n];
        const d = Math.hypot((p[0] - z.lon) * g.kx, (p[1] - z.lat) * KLAT);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) {
        items.push({
          name: cleanName,
          key: k,
          tokens: k.split(' '),
          lon: best[0],
          lat: best[1],
          len_m: z.r_m || 800,
          dir: compass(g, best[0], best[1]),
        });
      }
    }
  }

  // Also index Metro stations
  if (g.pois && g.pois.metro) {
    for (const st of g.pois.metro) {
      const cleanName = st.name_bn ? `${st.name} (${st.name_bn})` : `${st.name} MRT`;
      const k = norm(st.name + ' metro station');
      let best = null, bd = Infinity;
      for (let n = 0; n < g.nodes.length; n++) {
        const p = g.nodes[n];
        const d = Math.hypot((p[0] - st.ll[0]) * g.kx, (p[1] - st.ll[1]) * KLAT);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) {
        items.push({
          name: cleanName,
          key: k,
          tokens: k.split(' '),
          lon: best[0],
          lat: best[1],
          len_m: 500,
          dir: compass(g, best[0], best[1]),
        });
      }
    }
  }

  // Well-known Dhaka Landmarks (Bashundhara City, Jamuna Future Park, Dhanmondi Lake, etc.)
  const LANDMARKS = [
    { name: 'Bashundhara City Shopping Mall', name_bn: 'বসুন্ধরা সিটি শপিং মল (পান্থপথ)', lon: 90.390, lat: 23.751 },
    { name: 'Jamuna Future Park', name_bn: 'যমুনা ফিউচার পার্ক (বসুন্ধরা গেট)', lon: 90.424, lat: 23.814 },
    { name: 'Dhanmondi Lake', name_bn: 'ধানমন্ডি লেক পার্ক', lon: 90.377, lat: 23.746 },
    { name: 'TSC Dhaka University', name_bn: 'টিএসসি ও ঢাকা বিশ্ববিদ্যালয়', lon: 90.396, lat: 23.732 },
    { name: 'Evercare Hospital Dhaka', name_bn: 'এভারকেয়ার হাসপাতাল (বসুন্ধরা)', lon: 90.431, lat: 23.811 },
    { name: 'Square Hospital', name_bn: 'স্কয়ার হাসপাতাল (পান্থপথ)', lon: 90.387, lat: 23.753 },
  ];
  for (const lm of LANDMARKS) {
    const cleanName = lm.name_bn ? `${lm.name} (${lm.name_bn})` : lm.name;
    const k = norm(lm.name);
    let best = null, bd = Infinity;
    for (let n = 0; n < g.nodes.length; n++) {
      const p = g.nodes[n];
      const d = Math.hypot((p[0] - lm.lon) * g.kx, (p[1] - lm.lat) * KLAT);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) {
      items.push({
        name: cleanName,
        key: k,
        tokens: k.split(' '),
        lon: best[0],
        lat: best[1],
        len_m: 600,
        dir: compass(g, best[0], best[1]),
      });
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
    else if (it.key.includes(nq)) s = 50;
    else {
      s = 0;
      for (const q of qt) {
        if (it.tokens.includes(q)) s += 10;
        else if (it.tokens.some((x) => x.startsWith(q))) s += 5;
        else if (it.tokens.some((x) => x.includes(q))) s += 3;
        else { s = -1; break; }
      }
      if (s < 0) continue;
    }
    out.push([s + Math.min(it.len_m, 2000) / 2000, it]);      // longer streets first among equals
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
}
