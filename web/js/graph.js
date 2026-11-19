// Pure routing + scoring engine. No DOM, so it can be tested in Node against the Python version.
const KLAT = 110574;      // metres per degree of latitude (same constants as features.py)
const KLON0 = 111320;     // metres per degree of longitude at the equator
export const UNSAFE_FLOOR = 0.85;   // prototype rule: a street you flag "unsafe" scores at least this
export const COVERAGE_M = 150;      // a tap farther than this from any street node is "outside the area"

const r4 = (x) => Math.round(x * 1e4) / 1e4;   // Python stores risk rounded to 4 decimals

export function buildGraph(data) {
  const meta = data.meta, nodes = data.nodes;
  const lat0 = nodes.reduce((s, n) => s + n[1], 0) / nodes.length;
  const kx = KLON0 * Math.cos((lat0 * Math.PI) / 180);
  const edges = data.edges.map((r, i) => {
    const [u, v, len, hw, ni, light, road, act, pol, litKnown, mid] = r;
    const pts = [nodes[u], ...(Array.isArray(mid) ? mid : []), nodes[v]];
    const key = (u < v ? `${u}-${v}` : `${v}-${u}`) + `-${Math.round(len)}`;
    return { i, u, v, len, hw, name: ni >= 0 ? data.names[ni] : null,
             light, road, act, pol, litKnown: !!litKnown, pts, key };
  });
  const adj = nodes.map(() => []);
  for (const e of edges) adj[e.u].push(e.i);
  const byKey = new Map(), nodeKeys = nodes.map(() => new Set());
  for (const e of edges) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e.i);
    nodeKeys[e.u].add(e.key); nodeKeys[e.v].add(e.key);
  }
  const g = { meta, nodes, edges, adj, kx, byKey, nodeKeys, pois: data.pois || { police: [], hospital: [] } };
  setOverrides(g, new Map());
  return g;
}

function modeWeights(meta, night) {
  const w = { ...meta.weights };
  if (night) {
    for (const [k, m] of Object.entries(meta.night_mult)) w[k] *= m;
    const s = Object.values(w).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(w)) w[k] /= s;
  }
  return w;
}

/** overrides: Map(edgeKey -> {light?: 0|1, unsafe: {day, night}, n}). Recomputes all risks. */
export function setOverrides(g, overrides) {
  g.overrides = overrides;
  const wd = modeWeights(g.meta, false), wn = modeWeights(g.meta, true);
  const n = g.edges.length;
  g.risk = { day: new Float64Array(n), night: new Float64Array(n) };
  g.lightEff = new Float64Array(n);
  for (const e of g.edges) {
    const o = overrides.get(e.key);
    const L = o && o.light !== undefined ? o.light : e.light;
    let d = wd.lighting * L + wd.road * e.road + wd.activity * e.act + wd.police * e.pol;
    let nt = wn.lighting * L + wn.road * e.road + wn.activity * e.act + wn.police * e.pol;
    d = r4(d); nt = r4(nt);
    if (o && o.unsafe && o.unsafe.day) d = Math.max(d, UNSAFE_FLOOR);
    if (o && o.unsafe && o.unsafe.night) nt = Math.max(nt, UNSAFE_FLOOR);
    g.risk.day[e.i] = d; g.risk.night[e.i] = nt; g.lightEff[e.i] = L;
  }
}

export function distM(g, a, b) {
  return Math.hypot((a[0] - b[0]) * g.kx, (a[1] - b[1]) * KLAT);
}

export function nearestNode(g, lon, lat) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.nodes.length; i++) {
    const d = Math.hypot((g.nodes[i][0] - lon) * g.kx, (g.nodes[i][1] - lat) * KLAT);
    if (d < bd) { bd = d; best = i; }
  }
  return { id: best, dist: bd };
}

/** Closest street (by polyline) within maxM metres of a tap. Returns {edge, dist} or null. */
export function snapEdge(g, lon, lat, maxM = 45) {
  let best = null, bd = Infinity;
  const seen = new Set();
  for (const e of g.edges) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    for (let k = 0; k < e.pts.length - 1; k++) {
      const ax = (e.pts[k][0] - lon) * g.kx, ay = (e.pts[k][1] - lat) * KLAT;
      const bx = (e.pts[k + 1][0] - lon) * g.kx, by = (e.pts[k + 1][1] - lat) * KLAT;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < bd) { bd = d; best = e; }
    }
  }
  return best && bd <= maxM ? { edge: best, dist: bd } : null;
}

/** Direction (metres) leaving `node` along edge `e`. */
function dirAt(g, e, node) {
  const p = e.u === node ? e.pts[1] : e.pts[e.pts.length - 2], n = g.nodes[node];
  return [(p[0] - n[0]) * g.kx, (p[1] - n[1]) * KLAT];
}

/**
 * The stretch of street a report applies to: the tapped segment plus its continuation, up to about
 * maxM metres. Continue through a junction along the same street name, or else along the straightest
 * road of the same type (within 35 degrees). People report a lane, not a short piece between junctions.
 */
export function stretchOf(g, edge, maxM = 250, maxTurnDeg = 35) {
  const keys = [edge.key], seen = new Set(keys);
  let total = edge.len;
  const rep = (k) => g.edges[g.byKey.get(k)[0]];
  for (const start of [edge.u, edge.v]) {
    let node = start, cur = edge;
    while (total < maxM) {
      const all = [...g.nodeKeys[node]].filter((k) => k !== cur.key);
      let pick = null;
      const ok = all.filter((k) => { const c = rep(k);
        return c.hw === cur.hw && !(cur.name && c.name && cur.name !== c.name); });
      if (cur.name) {
        const same = ok.filter((k) => rep(k).name === cur.name);
        if (same.length === 1) pick = same[0];
      }
      if (pick === null && all.length === 1) pick = all[0];          // unbranched node
      if (pick === null && ok.length) {                                 // straightest continuation
        const din = dirAt(g, cur, node).map((v) => -v), nin = Math.hypot(din[0], din[1]) || 1;
        let best = Infinity;
        for (const k of ok) {
          const dout = dirAt(g, rep(k), node), nout = Math.hypot(dout[0], dout[1]) || 1;
          const ang = (Math.acos(Math.max(-1, Math.min(1, (din[0] * dout[0] + din[1] * dout[1]) / (nin * nout)))) * 180) / Math.PI;
          if (ang < best) { best = ang; pick = k; }
        }
        if (best > maxTurnDeg) pick = null;
      }
      if (pick === null || seen.has(pick)) break;
      const nx = rep(pick);
      seen.add(pick); keys.push(pick); total += nx.len;
      node = nx.u === node ? nx.v : nx.u;
      cur = nx;
    }
  }
  return { keys, length_m: total };
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/** Dijkstra with cost = length * (1 + alpha * risk). Returns a list of edge indices, or null. */
export function findPath(g, src, dst, alpha, night) {
  const risk = night ? g.risk.night : g.risk.day;
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  dist[src] = 0; heap.push(0, src);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    if (u === dst) break;
    for (const ei of g.adj[u]) {
      const e = g.edges[ei], nd = d + e.len * (1 + alpha * risk[ei]);
      if (nd < dist[e.v]) { dist[e.v] = nd; prev[e.v] = ei; heap.push(nd, e.v); }
    }
  }
  if (!Number.isFinite(dist[dst])) return null;
  const path = [];
  for (let v = dst; v !== src;) { const ei = prev[v]; path.push(ei); v = g.edges[ei].u; }
  return path.reverse();
}

export function describe(g, path, night) {
  const risk = night ? g.risk.night : g.risk.day;
  const HIGH = g.meta.high_risk, UNK = g.meta.light_unknown;
  let len = 0, wr = 0, hi = 0, lit = 0, unk = 0, quiet = 0;
  const coords = [], touched = new Set();   // touched: ids of the user's reports that apply
  path.forEach((ei, idx) => {
    const e = g.edges[ei];
    len += e.len; wr += e.len * risk[ei];
    if (risk[ei] >= HIGH) hi += e.len;
    if (g.lightEff[ei] === 0) lit += e.len;
    if (g.lightEff[ei] === UNK) unk += e.len;
    if (e.act >= 0.999) quiet += e.len;
    const ov = g.overrides.get(e.key);
    if (ov) for (const id of ov.ids) touched.add(id);
    for (const p of idx === 0 ? e.pts : e.pts.slice(1)) coords.push(p);
  });
  let minPolice = null;
  for (const p of g.pois.police || []) for (const c of coords) {
    const d = distM(g, p, c);
    if (minPolice === null || d < minPolice) minPolice = d;
  }
  const L = len || 1;
  return { path, length_m: len, mean_risk: wr / L, high_risk_share: hi / L, lit_share: lit / L,
           lighting_unknown_share: unk / L, quiet_share: quiet / L, user_reports: touched.size,
           nearest_police_m: minPolice, coords, sig: path.join(',') };
}

/** Three options (by alpha). `groups` merges identical paths and lists the highest-alpha option first. */
export function routeOptions(g, src, dst, night) {
  if (src === dst) return { error: 'same' };
  const options = [];
  for (const [name, alpha] of Object.entries(g.meta.alphas)) {
    const p = findPath(g, src, dst, alpha, night);
    if (!p) return { error: 'none' };
    options.push({ name, alpha, ...describe(g, p, night) });
  }
  const shortest = options.find((o) => o.alpha === 0) || options[0];
  const bySig = new Map();
  for (const o of [...options].sort((a, b) => b.alpha - a.alpha)) {
    if (!bySig.has(o.sig)) bySig.set(o.sig, { names: [], ...o });
    bySig.get(o.sig).names.push(o.name);
  }
  const groups = [...bySig.values()].map((gr) => ({ ...gr, extra_m: gr.length_m - shortest.length_m }));
  return { options, groups };
}
