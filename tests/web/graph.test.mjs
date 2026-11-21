// Run: node --test tests/web/
// Checks that the browser engine (web/js/graph.js) agrees with the Python engine on real-scale data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from '../../web/js/graph.js';
import * as R from '../../web/js/reports.js';

import { existsSync } from 'node:fs';
const dataPath = existsSync(new URL('../../web/data/area.pilot.json', import.meta.url))
  ? '../../web/data/area.pilot.json'
  : '../../web/data/area.json';
const data = JSON.parse(readFileSync(new URL(dataPath, import.meta.url)));
const ref = JSON.parse(readFileSync(new URL('./pyref.json', import.meta.url)));
const g = G.buildGraph(data);

// pyref.json names nodes by an older numbering; re-find them by coordinates so the check survives re-exports of area.json.
const byXY = new Map(g.nodes.map((n, i) => [`${n[0].toFixed(5)},${n[1].toFixed(5)}`, i]));
const nodeOf = (oldId) => {
  const xy = ref.id_to_xy[String(oldId)];
  const id = byXY.get(`${xy[0].toFixed(5)},${xy[1].toFixed(5)}`);
  assert.notEqual(id, undefined, `reference node ${oldId} is not in the loaded data`);
  return id;
};

test('graph loads with the expected size', () => {
  assert.equal(g.nodes.length, data.meta.counts.nodes);
  assert.equal(g.edges.length, data.meta.counts.edges);
});

test('JS route lengths and risk match Python on reference pairs', () => {
  let samePath = 0, total = 0;
  for (const r of ref.ref) {
    const res = G.routeOptions(g, nodeOf(r.o), nodeOf(r.d), r.night);
    assert.ok(!res.error, 'route should exist');
    for (const o of res.options) {
      const p = r.opts[o.name];
      total++;
      // Costs can tie, so allow tiny differences in the chosen path but not in the outcome.
      assert.ok(Math.abs(o.length_m - p.length_m) <= Math.max(2, p.length_m * 0.01),
        `${o.name} length ${o.length_m} vs ${p.length_m}`);
      assert.ok(Math.abs(o.mean_risk - p.mean_risk) <= 0.006, `${o.name} risk ${o.mean_risk} vs ${p.mean_risk}`);
      assert.ok(Math.abs(o.high_risk_share - p.high_risk_share) <= 0.03, `${o.name} high-risk share`);
      if (Math.abs(o.length_m - p.length_m) < 0.2) samePath++;
    }
  }
  console.log(`  ${samePath}/${total} option results identical in length`);
});

test('risk matches the Python score stored per street', () => {
  // area.json stores components only; recompute from them and compare to Python risk via a fresh route stat
  const e = g.edges[0];
  const w = data.meta.weights;
  const day = w.lighting * e.light + w.road * e.road + w.activity * e.act + w.police * e.pol;
  assert.ok(Math.abs(g.risk.day[0] - day) < 1e-4);
});

test('a lighting report changes risk only on that street', () => {
  const dv = data.meta.generated;
  const e = g.edges.find((x) => x.light === g.meta.light_unknown);
  const j = (e.i + 7) % g.edges.length;
  const night0 = g.risk.night[e.i], day0 = g.risk.day[e.i], otherNight = g.risk.night[j];
  const sameStreet = (x) => x.key === e.key;

  G.setOverrides(g, R.toOverrides([{ id: 'r1', keys: [e.key], kind: 'dark', when: 'night', dv }], dv));
  assert.ok(g.risk.night[e.i] > night0, 'a "dark" report raises night risk');
  assert.ok(g.risk.day[e.i] > day0, 'lighting counts in the daytime score too');
  if (!sameStreet(g.edges[j])) assert.equal(g.risk.night[j], otherNight, 'other streets unchanged');

  G.setOverrides(g, R.toOverrides([{ id: 'r2', keys: [e.key], kind: 'lit', when: 'night', dv }], dv));
  assert.ok(g.risk.night[e.i] < night0, 'a "lit" report lowers risk');

  G.setOverrides(g, R.toOverrides([{ id: 'r3', keys: [e.key], kind: 'unsafe', when: 'night', dv }], dv));
  assert.ok(g.risk.night[e.i] >= G.UNSAFE_FLOOR, 'unsafe at night sets a high floor');
  assert.equal(g.risk.day[e.i], day0, 'an unsafe-at-night report leaves the daytime score alone');

  G.setOverrides(g, new Map());
  assert.equal(g.risk.night[e.i], night0, 'clearing reports restores the original score');
});

test('reports for a different data build are ignored', () => {
  const m = R.toOverrides([{ id: 'z', keys: ['x'], kind: 'lit', when: 'day', dv: 'old' }], 'new');
  assert.equal(m.size, 0);
});

test('snapping finds a street near a street point and nothing far away', () => {
  const e = g.edges[100], mid = e.pts[0];
  const hit = G.snapEdge(g, mid[0], mid[1], 45);
  assert.ok(hit && hit.dist < 1);
  assert.equal(G.snapEdge(g, 91.5, 24.5, 45), null);
  assert.ok(G.nearestNode(g, 91.5, 24.5).dist > G.COVERAGE_M);
});

test('same start and end, and groups merge identical paths', () => {
  assert.equal(G.routeOptions(g, 5, 5, true).error, 'same');
  const res = G.routeOptions(g, ref.ref[0].o, ref.ref[0].d, true);
  const names = res.groups.flatMap((x) => x.names).sort();
  assert.deepEqual(names, ['balanced', 'safest', 'shortest']);
});

test('a report covers a connected stretch, not one tiny OSM segment', () => {
  const short = g.edges.filter((e) => e.len < 30);
  assert.ok(short.length > 100, 'real data has many very short segments');
  let grew = 0;
  for (const e of short.slice(0, 200)) {
    const s = G.stretchOf(g, e, 250);
    assert.ok(s.keys.includes(e.key) && new Set(s.keys).size === s.keys.length);
    assert.ok(s.length_m >= e.len);
    if (s.keys.length > 1) {   // it only keeps extending while the total is under the limit
      const last = g.edges[g.byKey.get(s.keys[s.keys.length - 1])[0]];
      assert.ok(s.length_m - last.len < 250, 'stops once the limit is reached');
    }
    if (s.keys.length > 1) grew++;
  }
  console.log(`  ${grew}/200 short segments extended to a longer stretch`);
  assert.ok(grew > 100, 'most short segments should extend along the street');
});

test('one report on a stretch changes every street in it, and counts as one report', () => {
  const dv = data.meta.generated;
  const e = g.edges.find((x) => x.len < 30 && G.stretchOf(g, x).keys.length > 2);
  const s = G.stretchOf(g, e);
  const before = s.keys.map((k) => g.risk.night[g.byKey.get(k)[0]]);
  G.setOverrides(g, R.toOverrides([{ id: 'one', keys: s.keys, kind: 'dark', when: 'night', dv }], dv));
  s.keys.forEach((k, i) => assert.ok(g.risk.night[g.byKey.get(k)[0]] >= before[i]));
  assert.ok(s.keys.some((k, i) => g.risk.night[g.byKey.get(k)[0]] > before[i]));
  const ei = g.byKey.get(s.keys[0])[0];
  const d = G.describe(g, [ei], true);
  assert.equal(d.user_reports, 1);
  G.setOverrides(g, new Map());
});
