"""Download OpenStreetMap data with osmnx 1.9.x. Needs internet; not run in the build sandbox."""
import json
import os
import pickle
import time
import warnings

from . import config as C


def _lonlat(gdf):
    pts = gdf.geometry.centroid
    return [[float(p.x), float(p.y)] for p in pts if p is not None and not p.is_empty]


def _with_retry(ox, fn, label):
    """Retry on server errors, rotating mirrors with exponential backoff.

    "No matching features" (InsufficientResponseError) is a real empty answer and is NOT retried.
    Any other failure that survives all attempts is raised, never turned into an empty result.
    """
    eps = C.OVERPASS_ENDPOINTS
    last = None
    for attempt in range(C.FETCH_ATTEMPTS):
        ox.settings.overpass_endpoint = eps[attempt % len(eps)]
        try:
            return fn()
        except ox._errors.InsufficientResponseError:
            raise
        except Exception as e:  # busy server, timeout, bad JSON, ...
            last = e
            wait = min(120, C.FETCH_BACKOFF_S * 2 ** (attempt // len(eps)))
            print(f"[{label}] attempt {attempt + 1}/{C.FETCH_ATTEMPTS} failed on "
                  f"{ox.settings.overpass_endpoint}: {str(e).splitlines()[0][:120]}. "
                  f"Retrying in {wait}s...", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"{label}: gave up after {C.FETCH_ATTEMPTS} attempts") from last


def fetch(bbox=None, place=None, out="data"):
    import osmnx as ox  # imported here so the rest of the package works without it
    warnings.filterwarnings("ignore", category=FutureWarning, module="dhaka_safe")

    ox.settings.useful_tags_way = list(set(ox.settings.useful_tags_way + ["lit", "highway", "name"]))
    ox.settings.requests_timeout = 180
    if bbox:
        north, south, east, west = bbox
        graph_fn = lambda: ox.graph_from_bbox(north, south, east, west, network_type=C.NETWORK_TYPE)
        get = lambda tags: ox.features_from_bbox(north, south, east, west, tags=tags)
        src = dict(north=north, south=south, east=east, west=west)
    else:
        place = place or C.PLACE
        graph_fn = lambda: ox.graph_from_place(place, network_type=C.NETWORK_TYPE)
        get = lambda tags: ox.features_from_place(place, tags=tags)
        src = {"place": place}

    G = _with_retry(ox, graph_fn, "streets")

    def pois_of(label, tags):
        try:
            return _lonlat(_with_retry(ox, lambda: get(tags), label))
        except ox._errors.InsufficientResponseError:
            return []  # genuinely none in this area

    pois = {
        "police": pois_of("police", {"amenity": ["police"]}),
        "hospital": pois_of("hospital", {"amenity": ["hospital", "clinic"]}),
        "activity": pois_of("activity", {"amenity": sorted(C.ACTIVITY_AMENITIES), "shop": True}),
        "bus_stop": pois_of("bus_stop", {"highway": ["bus_stop"]}),
    }
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "graph.pkl"), "wb") as f:
        pickle.dump(G, f)
    meta = {"source": src, "nodes": G.number_of_nodes(), "edges": G.number_of_edges(),
            "counts": {k: len(v) for k, v in pois.items()}}
    with open(os.path.join(out, "pois.json"), "w", encoding="utf-8") as f:
        json.dump({**pois, "_meta": meta}, f, ensure_ascii=False)
    return meta


def load(data):
    with open(os.path.join(data, "graph.pkl"), "rb") as f:
        G = pickle.load(f)
    with open(os.path.join(data, "pois.json"), encoding="utf-8") as f:
        pois = json.load(f)
    return G, pois
