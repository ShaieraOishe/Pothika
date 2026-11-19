"""Feature and scoring functions. No network access, so they are testable offline."""
import math

import numpy as np
from scipy.spatial import cKDTree

from . import config as C


def project(lonlat, lat0):
    """Equirectangular projection to metres around latitude lat0. Fine within one city."""
    a = np.asarray(lonlat, dtype=float).reshape(-1, 2)
    kx = 111_320.0 * math.cos(math.radians(lat0))
    return np.column_stack([a[:, 0] * kx, a[:, 1] * 110_574.0])


def nearest_distance_m(points, targets, lat0):
    """Metres from each point to its nearest target. inf if there are no targets."""
    pts = np.asarray(points, dtype=float).reshape(-1, 2)
    tg = np.asarray(targets, dtype=float).reshape(-1, 2)
    if len(tg) == 0:
        return np.full(len(pts), np.inf)
    d, _ = cKDTree(project(tg, lat0)).query(project(pts, lat0))
    return np.asarray(d, dtype=float)


def count_within(points, targets, radius_m, lat0):
    """Number of targets within radius_m of each point."""
    pts = np.asarray(points, dtype=float).reshape(-1, 2)
    tg = np.asarray(targets, dtype=float).reshape(-1, 2)
    if len(tg) == 0:
        return np.zeros(len(pts))
    tree = cKDTree(project(tg, lat0))
    return np.asarray(tree.query_ball_point(project(pts, lat0), r=radius_m,
                                            return_length=True), dtype=float)


def _clean(v):
    """Return None for missing values, and the first item for OSM list values."""
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v


def lighting_risk(lit):
    v = _clean(lit)
    if v is None:
        return C.LIGHTING_UNKNOWN
    return C.LIGHTING_RISK.get(str(v).strip().lower(), C.LIGHTING_UNKNOWN)


def road_risk(highway):
    h = _clean(highway)
    if h is None:
        return C.ROAD_RISK_DEFAULT
    return C.ROAD_RISK.get(str(h), C.ROAD_RISK_DEFAULT)


def combine(light, road, activity, police, night):
    """Weighted sum of components in [0, 1]. Night re-weights lighting and activity."""
    w = dict(C.WEIGHTS)
    if night:
        for k, m in C.NIGHT_MULT.items():
            w[k] *= m
        s = sum(w.values())
        w = {k: v / s for k, v in w.items()}
    return (w["lighting"] * light + w["road"] * road
            + w["activity"] * activity + w["police"] * police)


def score_graph(G, police=(), activity=()):
    """Set per-edge components and risk_day / risk_night. Returns a coverage report."""
    edges = list(G.edges(keys=True, data=True))
    if not edges:
        raise ValueError("graph has no edges")
    mids = np.array([[(G.nodes[u]["x"] + G.nodes[v]["x"]) / 2,
                      (G.nodes[u]["y"] + G.nodes[v]["y"]) / 2]
                     for u, v, _, _ in edges])
    lat0 = float(mids[:, 1].mean())

    pol_d = nearest_distance_m(mids, police, lat0)
    act_n = count_within(mids, activity, C.ACTIVITY_RADIUS_M, lat0)
    light = np.array([lighting_risk(d.get("lit")) for _, _, _, d in edges])
    road = np.array([road_risk(d.get("highway")) for _, _, _, d in edges])
    act_x = 1.0 / (1.0 + act_n / C.ACTIVITY_HALF)
    pol_x = np.where(np.isfinite(pol_d),
                     np.minimum(pol_d, C.POLICE_CAP_M) / C.POLICE_CAP_M, C.UNKNOWN)

    day = combine(light, road, act_x, pol_x, night=False)
    night = combine(light, road, act_x, pol_x, night=True)
    for (_, _, _, d), lt, rd, ac, po, dy, ni in zip(edges, light, road, act_x, pol_x, day, night):
        d.update(lighting=float(lt), road=float(rd), activity=float(ac), police=float(po),
                 risk_day=round(float(dy), 4), risk_night=round(float(ni), 4))

    n = len(edges)
    lit_tagged = sum(1 for _, _, _, d in edges if _clean(d.get("lit")) is not None)
    share_lit = lit_tagged / n
    warnings = []
    if share_lit < 0.3:
        warnings.append(f"Lighting tags cover {share_lit:.0%} of streets; the rest use the "
                        f"{C.LIGHTING_UNKNOWN:.0%} default, so lighting is mostly assumed.")
    mean_diff = float(np.abs(night - day).mean())
    if mean_diff < 0.03:
        warnings.append(f"Day and night scores differ by only {mean_diff:.3f} on average, so day/night "
                        "routes will be nearly identical until lighting data improves.")
    if len(police) < 3:
        warnings.append(f"Only {len(police)} police station(s) found; police-distance scores are unreliable.")
    if len(activity) < 10:
        warnings.append(f"Only {len(activity)} activity points found; the activity signal is weak.")
    return {
        "edges": n,
        "share_with_lit_tag": round(share_lit, 3),
        "police_points": len(police),
        "activity_points": len(activity),
        "share_within_police_cap": round(float(np.mean(np.isfinite(pol_d) & (pol_d <= C.POLICE_CAP_M))), 3),
        "share_with_activity_nearby": round(float(np.mean(act_n > 0)), 3),
        "mean_abs_day_night_diff": round(mean_diff, 4),
        "mean_risk_day": round(float(day.mean()), 3),
        "mean_risk_night": round(float(night.mean()), 3),
        "warnings": warnings,
    }
