"""GeoJSON export so results can be viewed in geojson.io or QGIS."""
import json


def edges_geojson(G, path):
    feats = []
    for u, v, d in G.edges(data=True):
        geom = d.get("geometry")
        coords = [list(c) for c in geom.coords] if geom is not None else \
            [[G.nodes[u]["x"], G.nodes[u]["y"]], [G.nodes[v]["x"], G.nodes[v]["y"]]]
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                      "properties": {k: d.get(k) for k in ("highway", "lit", "length", "lighting",
                                                           "road", "activity", "police",
                                                           "risk_day", "risk_night")}})
    _write(path, feats)


def routes_geojson(options, path):
    colors = {"shortest": "#888888", "balanced": "#f0a202", "safest": "#2a9d8f"}
    feats = []
    for name, r in options.items():
        if "error" in r or "coords" not in r:
            continue
        feats.append({"type": "Feature",
                      "geometry": {"type": "LineString", "coordinates": r["coords"]},
                      "properties": {"option": name, "stroke": colors.get(name, "#333"),
                                     "length_m": r["length_m"], "high_risk_share": r["high_risk_share"],
                                     "lit_share": r["lit_share"], "reasons": r["reasons"]}})
    _write(path, feats)


def _write(path, feats):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f, ensure_ascii=False)
