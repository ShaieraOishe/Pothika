"""Export a scored graph to one compact JSON file for the browser app (web/).

The browser recomputes risk from the four components using the weights stored in `meta`,
so Python and JavaScript share one source of truth (config.py).
"""
import json
import math
from datetime import datetime, timezone

from . import config as C
from .features import _clean

EDGE_FIELDS = ["u", "v", "len", "hw", "name", "light", "road", "act", "pol", "lit_known", "mid"]


def _r(x, nd=5):
    return round(float(x), nd)


def _first(v):
    v = _clean(v)
    return None if v is None else str(v)


def export_web(G, pois, path, area_bn="বসুন্ধরা আবাসিক ও আশপাশের এলাকা (পরীক্ষামূলক)",
               area_en="Bashundhara R/A and surroundings (pilot)"):
    nodes = list(G.nodes)
    idx = {n: i for i, n in enumerate(nodes)}
    xy = [[_r(G.nodes[n]["x"]), _r(G.nodes[n]["y"])] for n in nodes]

    names, name_ix = [], {}
    edges, lit_known = [], 0
    for u, v, d in G.edges(data=True):
        for k in ("lighting", "road", "activity", "police"):
            if k not in d:
                raise ValueError("graph is not scored; run `score` first")
        nm = _first(d.get("name"))
        ni = -1
        if nm:
            if nm not in name_ix:
                name_ix[nm] = len(names)
                names.append(nm)
            ni = name_ix[nm]
        mid = 0
        geom = d.get("geometry")
        if geom is not None:
            pts = [[_r(x), _r(y)] for x, y in geom.coords]
            a, b = xy[idx[u]], xy[idx[v]]
            # orient the polyline from u to v
            if (pts[0][0] - a[0]) ** 2 + (pts[0][1] - a[1]) ** 2 > \
               (pts[0][0] - b[0]) ** 2 + (pts[0][1] - b[1]) ** 2:
                pts.reverse()
            if len(pts) > 2:
                mid = pts[1:-1]
        hw = _first(d.get("highway")) or ""
        lk = 1 if _clean(d.get("lit")) is not None else 0
        lit_known += lk
        edges.append([idx[u], idx[v], round(float(d.get("length", 0.0)), 1), hw, ni,
                      round(float(d["lighting"]), 3), round(float(d["road"]), 3),
                      round(float(d["activity"]), 3), round(float(d["police"]), 3), lk, mid])

    xs, ys = [p[0] for p in xy], [p[1] for p in xy]
    meta = {
        "area": {"bn": area_bn, "en": area_en},
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "bbox": [min(xs), min(ys), max(xs), max(ys)],
        "weights": C.WEIGHTS, "night_mult": C.NIGHT_MULT,
        "alphas": C.ROUTE_ALPHAS, "high_risk": C.HIGH_RISK,
        "light_unknown": C.LIGHTING_UNKNOWN,
        "edge_fields": EDGE_FIELDS,
        "counts": {"nodes": len(nodes), "edges": len(edges),
                   "police": len(pois.get("police", [])), "hospital": len(pois.get("hospital", [])),
                   "activity": len(pois.get("activity", []))},
        "lit_tag_share": round(lit_known / max(1, len(edges)), 4),
        "credit": "Map data © OpenStreetMap contributors (ODbL)",
    }
    out = {"meta": meta, "nodes": xy, "names": names, "edges": edges,
           "pois": {"police": [[_r(a), _r(b)] for a, b in pois.get("police", [])],
                    "hospital": [[_r(a), _r(b)] for a, b in pois.get("hospital", [])]}}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    return meta["counts"] | {"lit_tag_share": meta["lit_tag_share"]}
