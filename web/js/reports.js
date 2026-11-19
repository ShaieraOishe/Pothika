// Street reports live ONLY on this device (localStorage, with an in-memory fallback).
// Nothing is sent anywhere. A report holds the street id, a kind, a day/night tag and a date, never the user's position.
const KEY = 'dsr.reports.v1';
let mem = [];

function read() { try { return localStorage.getItem(KEY); } catch { return null; } }
function write() { try { localStorage.setItem(KEY, JSON.stringify(mem)); return true; } catch { return false; } }

export function loadReports() {
  const raw = read();
  if (raw) { try { const a = JSON.parse(raw); if (Array.isArray(a)) mem = a; } catch { /* ignore corrupt data */ } }
  return mem;
}
export const getReports = () => mem;

export function addReport({ keys, name, kind, when, loc, dv, length_m }) {
  const r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              keys, name: name || null, kind, when, loc, dv, length_m: Math.round(length_m || 0),
              date: new Date().toISOString().slice(0, 10) };
  mem.push(r); write();
  return r;
}
export function removeReport(id) { mem = mem.filter((r) => r.id !== id); write(); }

/** Reports that match this data build become per-street overrides for the risk engine. */
export function toOverrides(reports, dv) {
  const m = new Map();
  for (const r of reports) {
    if (r.dv !== dv) continue;
    for (const key of r.keys || (r.key ? [r.key] : [])) {
      const o = m.get(key) || { unsafe: { day: false, night: false }, ids: new Set() };
      if (r.kind === 'lit') o.light = 0;
      else if (r.kind === 'dark') o.light = 1;
      else if (r.kind === 'unsafe') o.unsafe[r.when === 'day' ? 'day' : 'night'] = true;
      o.ids.add(r.id); m.set(key, o);
    }
  }
  return m;
}

export function exportJSON(reports) {
  return JSON.stringify({ app: 'dhaka-safe-routes', exported: new Date().toISOString().slice(0, 10),
                          note: 'Anonymous street reports kept on this device.', reports }, null, 2);
}
