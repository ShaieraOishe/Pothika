"""Offline tests on a tiny synthetic network. No OSM download needed."""
import math

import networkx as nx
import numpy as np
import pytest

from dhaka_safe import config as C
from dhaka_safe import features as F
from dhaka_safe import routing as R


def build_graph():
    # A -> D. Dark residential detour via M1 (short), lit primary detour via M2 (longer).
    G = nx.MultiDiGraph()
    nodes = {"A": (90.000, 23.800), "D": (90.002, 23.800),
             "M1": (90.001, 23.800), "M2": (90.001, 23.803)}
    for n, (x, y) in nodes.items():
        G.add_node(n, x=x, y=y)
    legs = [("A", "M1", "residential", "no", 100), ("M1", "D", "residential", "no", 100),
            ("A", "M2", "primary", "yes", 150), ("M2", "D", "primary", "yes", 150)]
    for u, v, hw, lit, L in legs:
        for a, b in ((u, v), (v, u)):
            G.add_edge(a, b, highway=hw, lit=lit, length=float(L))
    return G


def test_projection_and_distance():
    d = F.nearest_distance_m([(90.0, 23.8)], [(90.0, 23.8 + 0.001)], lat0=23.8)
    assert d[0] == pytest.approx(110.574, rel=1e-3)
    assert F.nearest_distance_m([(90, 23.8)], [], 23.8)[0] == math.inf


def test_count_within():
    n = F.count_within([(90.0, 23.8)], [(90.0, 23.8), (90.01, 23.8)], 150, 23.8)
    assert n[0] == 1


def test_lighting_and_road_defaults():
    assert F.lighting_risk(None) == C.LIGHTING_UNKNOWN
    assert F.lighting_risk(["yes", "no"]) == 0.0
    assert F.lighting_risk("no") == 1.0
    assert F.road_risk(None) == C.ROAD_RISK_DEFAULT
    assert F.road_risk(["footway", "x"]) == C.ROAD_RISK["footway"]


def test_night_is_riskier_for_dark_street():
    dark_day = F.combine(1.0, 0.5, 1.0, 0.5, night=False)
    dark_night = F.combine(1.0, 0.5, 1.0, 0.5, night=True)
    assert dark_night > dark_day
    assert F.combine(1.0, 0.5, 1.0, 0.5, night=True) == pytest.approx(0.816, abs=0.005)


def test_score_graph_writes_attributes_and_warnings():
    G = build_graph()
    rep = F.score_graph(G)
    dark = G["A"]["M1"][0]
    lit = G["A"]["M2"][0]
    assert dark["risk_night"] > lit["risk_night"]
    assert rep["edges"] == 8
    assert any("police" in w.lower() for w in rep["warnings"])


def test_safest_route_at_night_avoids_dark_street():
    G = build_graph()
    F.score_graph(G)
    res = R.route_options(G, "A", "D", night=True)
    assert res["shortest"]["path"] == ["A", "M1", "D"]
    assert res["safest"]["path"] == ["A", "M2", "D"]
    assert res["safest"]["high_risk_share"] < res["shortest"]["high_risk_share"]
    assert res["safest"]["length_m"] > res["shortest"]["length_m"]
    assert res["safest"]["reasons"]


def test_identical_options_are_flagged():
    G = build_graph()
    F.score_graph(G)
    res = R.route_options(G, "A", "D", night=False)
    # In daytime the dark street is only slightly worse, so balanced/safest may match shortest.
    assert res["shortest"].get("same_as") is None
    for name in ("balanced", "safest"):
        assert "path" in res[name]


def test_nearest_node():
    G = build_graph()
    assert R.nearest_node(G, 23.8001, 90.0001) == "A"
    assert R.nearest_node(G, 23.8, 90.0021) == "D"


def test_no_path_reports_error():
    G = build_graph()
    G.add_node("Z", x=91.0, y=24.0)
    F.score_graph(G)
    assert "error" in R.route_options(G, "A", "Z", night=False)


def test_unknown_lighting_is_reported_not_called_unlit():
    G = build_graph()
    for _, _, d in G.edges(data=True):
        d.pop("lit")          # no lighting data at all
    F.score_graph(G)
    res = R.route_options(G, "A", "D", night=True)
    assert res["shortest"]["lighting_unknown_share"] == 1.0
    assert any("lighting data is missing" in r.lower() for r in res["shortest"]["reasons"])


def test_evaluate_runs_and_shows_benefit_on_synthetic_graph():
    G = build_graph()
    F.score_graph(G)
    out = R.evaluate(G, n=10, seed=1, min_dist_m=0, night=True)
    assert out["pairs"] > 0
    assert 0.0 <= out["share_where_safest_differs"] <= 1.0


def test_export_web_roundtrip(tmp_path):
    import json
    from dhaka_safe import webexport
    G = build_graph()
    F.score_graph(G, police=[(90.0005, 23.8)])
    out = tmp_path / "area.json"
    info = webexport.export_web(G, {"police": [[90.0005, 23.8]], "hospital": []}, str(out))
    d = json.loads(out.read_text(encoding="utf-8"))
    assert info["edges"] == 8 and len(d["edges"]) == 8 and len(d["nodes"]) == 4
    assert d["meta"]["weights"] == C.WEIGHTS and d["meta"]["edge_fields"] == webexport.EDGE_FIELDS
    assert all(len(e) == len(webexport.EDGE_FIELDS) for e in d["edges"])
    assert d["pois"]["police"] == [[90.0005, 23.8]]


def test_export_web_requires_scored_graph(tmp_path):
    from dhaka_safe import webexport
    with pytest.raises(ValueError):
        webexport.export_web(build_graph(), {}, str(tmp_path / "x.json"))
