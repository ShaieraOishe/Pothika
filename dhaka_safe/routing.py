"""Route options that trade distance against the risk score. Offline, testable."""
import math
import random

import networkx as nx
import numpy as np

from . import config as C


def nearest_node(G, lat, lon):
    nodes = list(G.nodes)
    xy = np.array([[G.nodes[n]["x"], G.nodes[n]["y"]] for n in nodes], dtype=float)
    kx = math.cos(math.radians(lat))
    d2 = ((xy[:, 0] - lon) * kx) ** 2 + (xy[:, 1] - lat) ** 2
    return nodes[int(np.argmin(d2))]


def _edges_of(d):
    """A networkx multigraph hands the weight function a dict of parallel edges."""
    return [d] if "length" in d else list(d.values())


def weight_fn(alpha, night):
    key = "risk_night" if night else "risk_day"

    def w(u, v, d):
        best = math.inf
        for e in _edges_of(d):
            best = min(best, float(e.get("length", 1.0)) * (1.0 + alpha * float(e.get(key, 0.5))))
        return best
    return w


def _best_edge(G, u, v, fn):
    """Parallel edge with the lowest cost between u and v."""
    cands = G[u][v]
    k = min(cands, key=lambda k: fn(u, v, {k: cands[k]}))
    return cands[k]


def _describe(G, path, night):
    key = "risk_night" if night else "risk_day"
    edges = [_best_edge(G, u, v, weight_fn(0.0, night)) for u, v in zip(path[:-1], path[1:])]
    lengths = np.array([float(e.get("length", 0.0)) for e in edges])
    risks = np.array([float(e.get(key, 0.5)) for e in edges])
    lit = np.array([float(e.get("lighting", C.LIGHTING_UNKNOWN)) == 0.0 for e in edges])
    unknown_light = np.array([float(e.get("lighting", C.LIGHTING_UNKNOWN)) == C.LIGHTING_UNKNOWN
                              for e in edges])
    total = float(lengths.sum()) or 1.0
    return {
        "length_m": round(total, 1),
        "mean_risk": round(float((lengths * risks).sum() / total), 3),
        "high_risk_share": round(float(lengths[risks >= C.HIGH_RISK].sum() / total), 3),
        "lit_share": round(float(lengths[lit].sum() / total), 3),
        "lighting_unknown_share": round(float(lengths[unknown_light].sum() / total), 3),
        "segments": len(edges),
        "coords": [[G.nodes[n]["x"], G.nodes[n]["y"]] for n in path],
    }


def _reasons(stats, night, shortest_stats):
    when = "at night" if night else "in daytime"
    out = []
    if stats["high_risk_share"] <= 0.05:
        out.append(f"Almost no high-risk streets on this route {when}.")
    else:
        out.append(f"About {stats['high_risk_share']:.0%} of this route is on streets scored high-risk {when}.")
    if stats["lighting_unknown_share"] > 0.8:
        out.append("Street-lighting data is missing for most of this route, so lighting is not "
                   "counted in this score.")
    else:
        out.append(f"About {stats['lit_share']:.0%} of this route is on streets tagged as lit.")
    if shortest_stats and stats["length_m"] > shortest_stats["length_m"] * 1.001:
        extra = stats["length_m"] - shortest_stats["length_m"]
        out.append(f"It is {extra:.0f} m longer than the shortest route.")
    return out


def route_options(G, origin, dest, night=False, alphas=None):
    """Return a dict of route options: shortest, balanced, safest (or custom alphas)."""
    alphas = alphas or C.ROUTE_ALPHAS
    results, seen = {}, {}
    shortest_stats = None
    for name, alpha in alphas.items():
        try:
            path = nx.shortest_path(G, origin, dest, weight=weight_fn(alpha, night))
        except nx.NetworkXNoPath:
            return {"error": "No walking route between these points in the loaded area."}
        stats = _describe(G, path, night)
        if name == "shortest":
            shortest_stats = stats
        key = tuple(path)
        if key in seen:
            stats["same_as"] = seen[key]
        else:
            seen[key] = name
        stats["path"] = list(path)
        stats["reasons"] = _reasons(stats, night, shortest_stats)
        results[name] = stats
    return results


def evaluate(G, n=200, seed=0, min_dist_m=1000.0, night=True, alphas=None):
    """Compare shortest vs safest over random origin/destination pairs.

    Answers: how often does the safest option differ, what does it cost in extra distance,
    and how much does it reduce the share of high-risk street length?
    """
    rng = random.Random(seed)
    nodes = list(G.nodes)
    lat0 = float(np.mean([G.nodes[v]["y"] for v in nodes]))
    kx = 111_320.0 * math.cos(math.radians(lat0))

    def dist(a, b):
        return math.hypot((G.nodes[a]["x"] - G.nodes[b]["x"]) * kx,
                          (G.nodes[a]["y"] - G.nodes[b]["y"]) * 110_574.0)

    rows, tries = [], 0
    while len(rows) < n and tries < 50 * n:
        tries += 1
        o, d = rng.sample(nodes, 2)
        if dist(o, d) < min_dist_m:
            continue
        res = route_options(G, o, d, night=night, alphas=alphas)
        if "error" in res:
            continue
        sh, sf = res["shortest"], res["safest"]
        rows.append({
            "differs": sf["path"] != sh["path"],
            "extra_pct": (sf["length_m"] / sh["length_m"] - 1.0) * 100.0,
            "hr_cut_pts": (sh["high_risk_share"] - sf["high_risk_share"]) * 100.0,
            "risk_cut": sh["mean_risk"] - sf["mean_risk"],
        })
    if not rows:
        return {"pairs": 0}
    diff = [r for r in rows if r["differs"]]
    med = lambda xs: round(float(np.median(xs)), 3) if xs else None
    return {
        "pairs": len(rows),
        "share_where_safest_differs": round(len(diff) / len(rows), 3),
        "median_extra_distance_pct_when_differs": med([r["extra_pct"] for r in diff]),
        "median_high_risk_cut_pts_when_differs": med([r["hr_cut_pts"] for r in diff]),
        "median_mean_risk_cut_when_differs": med([r["risk_cut"] for r in diff]),
        "mean_high_risk_cut_pts_all_pairs": round(float(np.mean([r["hr_cut_pts"] for r in rows])), 3),
    }
