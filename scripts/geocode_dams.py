#!/usr/bin/env python3
"""One-time geocoding helper for map placement.

Engineering values come from the official source attached to each seed record.
Coordinates are technical map-placement data from OpenStreetMap Nominatim and are
not presented as an official engineering parameter.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SEED_PATH = ROOT / "data" / "dams.seed.json"
OUTPUT_PATH = ROOT / "data" / "dams.geojson"
USER_AGENT = "yangtze-dam-seismic-map/1.0 (research map; GitHub Pages)"

# Nominatim can confuse dams with same-named places. These six points were
# corrected from published coordinate records after manual review.
COORDINATE_OVERRIDES = {
    "wudongde": [102.63403, 26.32483],
    "ludila": [100.81646, 26.20144],
    "lianghekou": [101.00972, 30.19444],
    "caojie": [106.38861, 29.90750],
    "dongfeng": [106.15540, 26.85450],
    "shatuo": [108.47528, 28.49806],
    "yinpan": [107.8904694, 29.2746813],
    "baima": [107.537068, 29.406186],
}


def geocode(query: str) -> tuple[float, float] | None:
    name = query.split(",", 1)[0].strip()
    variants = [
        query,
        name.replace("水电站", "水库").replace("水利枢纽", "水库").replace("航电枢纽", "水库"),
        name,
    ]
    for variant in dict.fromkeys(variants):
        params = urllib.parse.urlencode({"q": variant, "format": "jsonv2", "limit": 1, "countrycodes": "cn"})
        request = urllib.request.Request(
            f"https://nominatim.openstreetmap.org/search?{params}",
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        if payload:
            return float(payload[0]["lon"]), float(payload[0]["lat"])
        time.sleep(1.05)
    return None


def main() -> None:
    seeds = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    existing = {}
    if OUTPUT_PATH.exists():
        current = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
        existing = {feature["properties"]["id"]: feature["geometry"]["coordinates"] for feature in current.get("features", [])}

    features = []
    unresolved = []
    for index, seed in enumerate(seeds):
        coordinates = COORDINATE_OVERRIDES.get(seed["id"]) or existing.get(seed["id"])
        if not coordinates:
            result = geocode(seed["query"])
            if result:
                coordinates = list(result)
            else:
                unresolved.append(seed["id"])
                continue
            if index < len(seeds) - 1:
                time.sleep(1.05)

        properties = {key: value for key, value in seed.items() if key not in {"query"}}
        properties["coordinatesSource"] = (
            "公开坐标记录人工复核" if seed["id"] in COORDINATE_OVERRIDES else "OpenStreetMap Nominatim"
        )
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": coordinates}, "properties": properties})

    output = {
        "type": "FeatureCollection",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "coordinateNote": "坐标仅用于地图定位，来自 OpenStreetMap Nominatim；工程参数以各条官方来源为准。",
        "features": features,
    }
    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(features)} dams to {OUTPUT_PATH}")
    if unresolved:
        print("Unresolved: " + ", ".join(unresolved))


if __name__ == "__main__":
    main()
