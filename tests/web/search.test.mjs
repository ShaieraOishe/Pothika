import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph, nearestNode } from '../../web/js/graph.js';
import { norm, buildIndex, search } from '../../web/js/search.js';

import { existsSync } from 'node:fs';
const dataPath = existsSync(new URL('../../web/data/area.pilot.json', import.meta.url))
  ? '../../web/data/area.pilot.json'
  : '../../web/data/area.json';
const g = buildGraph(JSON.parse(readFileSync(new URL(dataPath, import.meta.url))));
const items = buildIndex(g);

test('norm treats Bangla and English road names alike', () => {
  assert.equal(norm('সড়ক ১১'), 'road 11');
  assert.equal(norm('Road No. 10'), 'road 10');
  assert.equal(norm('  Road   10 '), 'road 10');
  assert.equal(norm('সোহরাওয়ার্দী এভিনিউ'), 'সোহরাওয়ার্দী avenue');
  assert.equal(norm('সড়ক ১১'.normalize('NFD')), 'road 11');   // same word, different Unicode form
  assert.equal(norm(null), '');
});

test('index covers the named streets and every item is a real junction inside the area', () => {
  if (g.meta.counts && !g.edges.some((e) => e.name)) return;   // data exported without street names
  assert.ok(items.length > 100, `only ${items.length} items`);
  const [w, s, e, n] = g.meta.bbox;
  for (const it of items) {
    assert.ok(it.lon >= w && it.lon <= e && it.lat >= s && it.lat <= n, it.name);
    assert.ok(nearestNode(g, it.lon, it.lat).dist < 1, `${it.name} is not on a node`);
    assert.ok(it.len_m > 0);
  }
});

test('search ranks exact names first and understands both scripts', () => {
  if (!items.length) return;
  const r = search(items, 'road 10');
  assert.ok(r.length >= 1); assert.equal(r[0].key, 'road 10');
  const bn = search(items, 'সড়ক ১১');
  assert.ok(bn.every((x) => x.key.startsWith('road 11') || x.tokens.includes('11') || x.tokens.some((t) => t.startsWith('11'))));
  assert.ok(bn.length >= 1);
  assert.equal(bn[0].key, 'road 11', 'the exact Bangla name should come first');
  assert.deepEqual(search(items, 'zzzzqq'), []);
  assert.deepEqual(search(items, '   '), []);
  assert.ok(search(items, 'road', 4).length <= 4);
});

test('prefix typing works and an exact match beats a longer name that merely starts with it', () => {
  if (!items.length) return;
  assert.equal(search(items, 'road 1')[0].key, 'road 1');
  assert.ok(search(items, 'fela').some((x) => x.key.startsWith('felani')));
});
