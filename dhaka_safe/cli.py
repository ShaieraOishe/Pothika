import argparse
import json
import os
import pickle
import sys

from . import config as C


def _pair(s):
    try:
        lat, lon = (float(x) for x in s.split(","))
    except ValueError:
        raise SystemExit(f"Expected LAT,LON as two numbers like 23.815,90.425 but got {s!r}. "
                         "Copy real coordinates from Google Maps (right-click a spot).")
    return lat, lon


def cmd_fetch(a):
    from . import osm
    bbox = tuple(float(x) for x in a.bbox) if a.bbox else None
    meta = osm.fetch(bbox=bbox, place=a.place, out=a.out)
    print(json.dumps(meta, indent=2, ensure_ascii=False))


def cmd_score(a):
    from . import features, osm, export
    G, pois = osm.load(a.data)
    report = features.score_graph(G, police=pois["police"], activity=pois["activity"])
    with open(os.path.join(a.data, "graph.pkl"), "wb") as f:
        pickle.dump(G, f)
    export.edges_geojson(G, os.path.join(a.data, "streets_scored.geojson"))
    with open(os.path.join(a.data, "score_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(json.dumps(report, indent=2, ensure_ascii=False))


def cmd_route(a):
    from . import osm, routing, export
    G, _ = osm.load(a.data)
    o = routing.nearest_node(G, *_pair(a.frm))
    d = routing.nearest_node(G, *_pair(a.to))
    alphas = dict(C.ROUTE_ALPHAS)
    if a.safest_alpha is not None:
        alphas["safest"] = a.safest_alpha
    res = routing.route_options(G, o, d, night=(a.time == "night"), alphas=alphas)
    export.routes_geojson(res, os.path.join(a.data, "routes.geojson"))
    printable = {k: ({kk: vv for kk, vv in v.items() if kk not in ("path", "coords")}
                     if isinstance(v, dict) else v) for k, v in res.items()}
    print(json.dumps(printable, indent=2, ensure_ascii=False))


def cmd_evaluate(a):
    from . import osm, routing
    G, _ = osm.load(a.data)
    alphas = dict(C.ROUTE_ALPHAS)
    if a.safest_alpha is not None:
        alphas["safest"] = a.safest_alpha
    out = routing.evaluate(G, n=a.n, seed=a.seed, min_dist_m=a.min_dist,
                           night=(a.time == "night"), alphas=alphas)
    out["safest_alpha"] = alphas["safest"]
    print(json.dumps(out, indent=2))


def cmd_export_web(a):
    from . import osm, webexport
    G, pois = osm.load(a.data)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    info = webexport.export_web(G, pois, a.out)
    print(json.dumps(info, indent=2), f"\nwrote {a.out} ({os.path.getsize(a.out) / 1e6:.2f} MB)")


def main(argv=None):
    p = argparse.ArgumentParser(prog="dhaka_safe")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="download OSM streets and points of interest")
    g = f.add_mutually_exclusive_group()
    g.add_argument("--place", default=None, help=f"default: {C.PLACE}")
    g.add_argument("--bbox", nargs=4, metavar=("NORTH", "SOUTH", "EAST", "WEST"))
    f.add_argument("--out", default="data")
    f.set_defaults(fn=cmd_fetch)

    s = sub.add_parser("score", help="compute per-street risk scores")
    s.add_argument("--data", default="data")
    s.set_defaults(fn=cmd_score)

    r = sub.add_parser("route", help="route options between two points")
    r.add_argument("--data", default="data")
    r.add_argument("--from", dest="frm", required=True, metavar="LAT,LON")
    r.add_argument("--to", required=True, metavar="LAT,LON")
    r.add_argument("--time", choices=["day", "night"], default="day")
    r.add_argument("--safest-alpha", type=float, default=None,
                   help=f"risk penalty for the safest option (default {C.ROUTE_ALPHAS['safest']})")
    r.set_defaults(fn=cmd_route)

    e = sub.add_parser("evaluate", help="compare shortest vs safest over random pairs")
    e.add_argument("--data", default="data")
    e.add_argument("--n", type=int, default=200)
    e.add_argument("--seed", type=int, default=0)
    e.add_argument("--min-dist", type=float, default=1000.0, help="minimum straight-line metres")
    e.add_argument("--time", choices=["day", "night"], default="night")
    e.add_argument("--safest-alpha", type=float, default=None)
    e.set_defaults(fn=cmd_evaluate)

    w = sub.add_parser("export-web", help="write the compact JSON the web app loads")
    w.add_argument("--data", default="data")
    w.add_argument("--out", default="web/data/area.json")
    w.set_defaults(fn=cmd_export_web)

    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
