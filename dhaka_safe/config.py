"""All tunable assumptions in one place.

Every number here is a documented prior, NOT a measured value. Validate them
against the survey (Q7, Q16, Q17) before describing any score as accurate.
"""

PLACE = "Dhaka, Bangladesh"   # used when no --bbox is given; check the printed extent
NETWORK_TYPE = "walk"

# Daytime component weights (sum to 1).
WEIGHTS = {"lighting": 0.35, "road": 0.25, "activity": 0.20, "police": 0.20}
# At night, lighting and low activity matter more. Weights are re-normalised after scaling.
NIGHT_MULT = {"lighting": 1.5, "activity": 1.25}

# Exposure prior by OSM highway class, 0 = low, 1 = high.
ROAD_RISK = {
    "trunk": 0.3, "primary": 0.3, "secondary": 0.35, "tertiary": 0.4,
    "unclassified": 0.5, "residential": 0.5, "living_street": 0.4,
    "service": 0.6, "pedestrian": 0.3, "footway": 0.7, "path": 0.75,
    "steps": 0.7, "track": 0.7,
}
ROAD_RISK_DEFAULT = 0.6

# OSM "lit" tag to lighting risk. Missing tag uses LIGHTING_UNKNOWN.
LIGHTING_RISK = {"yes": 0.0, "24/7": 0.0, "automatic": 0.0, "limited": 0.4, "no": 1.0}
LIGHTING_UNKNOWN = 0.5
UNKNOWN = 0.5

ACTIVITY_RADIUS_M = 150     # shops/cafes/etc. within this radius of a road
ACTIVITY_HALF = 3           # activity risk = 1 / (1 + count / ACTIVITY_HALF)
ACTIVITY_AMENITIES = {"restaurant", "cafe", "fuel", "pharmacy", "bank"}
POLICE_CAP_M = 2000         # police risk = min(distance, cap) / cap

# Routing: cost = length * (1 + alpha * risk). alpha 0 = plain shortest path.
ROUTE_ALPHAS = {"shortest": 0.0, "balanced": 2.0, "safest": 6.0}
HIGH_RISK = 0.6             # a street with risk at or above this counts as high-risk

# Public Overpass mirrors, tried in rotation when one is busy. Availability changes; edit as needed.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api",
    "https://overpass.private.coffee/api",
    "https://overpass.kumi.systems/api",
]
FETCH_ATTEMPTS = 8          # total tries across all mirrors
FETCH_BACKOFF_S = 10        # first wait; doubles every full pass through the mirrors, capped at 120 s
