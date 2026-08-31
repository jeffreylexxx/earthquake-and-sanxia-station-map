#!/usr/bin/env python3
"""Build the curated geohazard layer and calculate the nearest mapped dam.

The seed file contains only source-verified significant incidents. Coordinates
are for regional map placement and are geocoded from the published place name;
they are not survey-grade accident boundaries.
"""

from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SEED_PATH = DATA / "geohazards.seed.json"
OUTPUT_PATH = DATA / "geohazards.geojson"
DAMS_PATH = DATA / "dams.geojson"
USER_AGENT = "yangtze-dam-seismic-map/1.1 (research map; GitHub Pages)"

# Coordinates are locality-level map anchors reviewed against the named
# village/town in the official source. They must not be read as parcel bounds.
COORDINATE_OVERRIDES: dict[str, list[float]] = {}


def geocode(query: str) -> tuple[float, float, str] | None:
    variants = [query]
    parts = [part.strip() for part in query.split(",") if part.strip()]
    if len(parts) > 2:
        variants.extend([", ".join(parts[1:]), ", ".join(parts[2:])])
    for variant in dict.fromkeys(variants):
        params = urllib.parse.urlencode({"q": variant, "format": "jsonv2", "limit": 1, "countrycodes": "cn"})
        request = urllib.request.Request(
            f"https://nominatim.openstreetmap.org/search?{params}",
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        if payload:
            return float(payload[0]["lon"]), float(payload[0]["lat"]), variant
        time.sleep(1.05)
    return None


def haversine_km(a: list[float], b: list[float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * math.asin(math.sqrt(value))


def main() -> None:
    seeds = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    dams = json.loads(DAMS_PATH.read_text(encoding="utf-8"))["features"]
    existing: dict[str, list[float]] = {}
    if OUTPUT_PATH.exists():
        current = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
        existing = {
            feature["properties"]["eventId"]: feature["geometry"]["coordinates"]
            for feature in current.get("features", [])
        }

    features = []
    unresolved = []
    for index, seed in enumerate(seeds):
        coordinates = COORDINATE_OVERRIDES.get(seed["eventId"]) or existing.get(seed["eventId"])
        geocoded_query = seed["query"]
        if not coordinates:
            result = geocode(seed["query"])
            if not result:
                unresolved.append(seed["eventId"])
                continue
            coordinates = [result[0], result[1]]
            geocoded_query = result[2]
            if index < len(seeds) - 1:
                time.sleep(1.05)

        nearest = min(dams, key=lambda dam: haversine_km(coordinates, dam["geometry"]["coordinates"]))
        distance = haversine_km(coordinates, nearest["geometry"]["coordinates"])
        properties = {key: value for key, value in seed.items() if key != "query"}
        properties.update({
            "nearestDam": nearest["properties"]["name"],
            "nearestDamId": nearest["properties"]["id"],
            "nearestBasin": nearest["properties"]["basin"],
            "nearestDamKm": round(distance, 1),
            "coordinatePrecision": "村镇级区域定位",
            "coordinateSource": "OpenStreetMap Nominatim",
            "geocodedQuery": geocoded_query,
        })
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": coordinates}, "properties": properties})

    output = {
        "type": "FeatureCollection",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scope": "官方或权威来源可核验、位于水坝/简化水道200公里走廊内的重要滑坡、崩塌与泥石流事件；默认显示滚动十年。",
        "coordinateNote": "事件点按官方资料中的村镇地名进行区域定位，不代表灾害边界或测绘级坐标。",
        "features": features,
    }
    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(features)} geohazards to {OUTPUT_PATH}")
    if unresolved:
        print("Unresolved: " + ", ".join(unresolved))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
