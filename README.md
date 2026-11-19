# Pothika (পথিকা): safe routing for women in Dhaka

Data pipeline, routing engine and a Bangla-first web app. (Python package and folder keep the working name `dhaka_safe`.)

A heuristic street-risk score and a 3-option route planner for Dhaka, built from OpenStreetMap.
**The scores are priors, not validated risk.** Check them against the survey before describing them as accurate.

## What it does
1. `fetch`: downloads walking streets and points of interest (police, hospitals, shops/cafes/fuel/pharmacy/banks, bus stops).
2. `score`: gives each street segment a lighting, road-type, activity and police-distance component, then a day score and a night score.
3. `route`: returns shortest, balanced and safest routes between two points, with plain-language reasons.

## Run
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt   # Python 3.13 is fine; osmnx 1.x is pinned below 2
python -m pytest -q                     # offline tests, no download
python -m dhaka_safe fetch --bbox 23.82 23.79 90.44 90.41 --out data   # Bashundhara R/A first
python -m dhaka_safe score --data data
python -m dhaka_safe route --data data --from 23.8103,90.4125 --to 23.8200,90.4300 --time night
```
Open `data/streets_scored.geojson` and `data/routes.geojson` in geojson.io or QGIS.

## Method (all weights in `dhaka_safe/config.py`)
- Components are each 0 (safe) to 1 (risky): lighting from OSM `lit` (unknown = 0.5), road type prior, activity `1/(1+n/3)` within 150 m, police distance capped at 2 km.
- Day weights: lighting .35, road .25, activity .20, police .20. Night multiplies lighting by 1.5 and activity by 1.25, then re-normalises.
- Route cost = length × (1 + α × risk). α = 0 (shortest), 2 (balanced), 6 (safest).

## Web app (PWA, Bangla first)
`web/` is a static, installable web app that runs the same scoring and routing in the browser. There is no server and no account.

```bash
python -m dhaka_safe export-web --data data --out web/data/area.json   # optional: refresh data, adds street names
cd web && python -m http.server 8000                                    # then open http://localhost:8000 on this computer
```
To try it on a phone, deploy the `web/` folder to any static host (GitHub Pages works). The service worker needs HTTPS or localhost.

What it does:
- Set a start and a destination by typing a street name (works in Bangla or English, for example `road 10` or `সড়ক ১১`) or by tapping the map. You can also start from your location, which is read once and never stored. Drag the markers to adjust. The search runs on the street names already in the app, so it works offline and nothing you type is sent anywhere.
- Day or night: the interface itself switches between a day and a dusk look. Three route options, each with plain-language reasons and an "Estimate" label. If two options are the same path they are shown as one.
- Report a street as lit, dark or unsafe. A report covers about 250 m of the connected street and is stored only in this browser. It changes this device's route results immediately. Nothing is uploaded; reports can be downloaded as JSON.
- Optional map layers: relative estimated risk, police stations, hospitals and clinics.
- Works offline after the first visit (map tiles need a connection; the street network is drawn from the bundled data).
- Bangla and English; the choice is remembered.

Tests:
```bash
python -m pytest -q          # Python engine
node --test tests/web/graph.test.mjs tests/web/search.test.mjs   # browser engine vs the Python reference; street search
python tests/web/e2e_phone.py && python tests/web/e2e_misc.py   # optional browser checks; needs `pip install playwright` and `python -m http.server 8765` running in web/
```
The browser checks open the app with `?debug`, which exposes the app state for the tests. It is off otherwise.

Web-specific limits:
- Reports are local only. There is no shared safety map yet, which needs a backend with moderation and abuse protection.
- A report's effect is a simple rule: "lit" sets lighting risk to 0, "dark" to 1, "unsafe" sets a floor of 0.85 for the chosen time of day. These are prototype rules, not calibrated.
- Search finds only named streets inside the mapped area (about half of the streets have no name in OpenStreetMap) and picks the middle junction of the street. It does not find shops, landmarks or house addresses. The search fields are screen-reader friendly, but the map itself is not.
- Bangla wording should be reviewed by a native speaker before public release. Emergency numbers shown: 999 and 109 (checked against two Daily Star articles, 2020 and 2025).
- The bundled font is Anek Bangla (SIL OFL); the map library is Leaflet 1.9.4 (BSD-2).

## Known limits
- OSM lighting tags are sparse in Dhaka. The `score` report warns when fewer than 30% of streets have a `lit` tag, and most lighting values are then defaults.
- Police and activity points come from OSM, which may be incomplete. The report lists the point counts.
- Walking network only. Footbridges and informal paths may be missing.
- Nothing here is validated against incident or survey data yet (survey Q7, Q16, Q17 are for that).
- Bangla labels for the routing reasons are not written yet.
