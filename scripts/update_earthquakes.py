#!/usr/bin/env python3
"""Fetch and retain earthquake records from the official USGS FDSN catalog.

Rules:
- Bootstrap from EARTHQUAKE_BOOTSTRAP_START (default 2016-08-30).
- Later runs re-fetch the latest 14 days so catalog revisions are absorbed.
- Existing records are never deleted, including records older than ten years.
- Only M3.0+ events within 200 km of a selected dam or simplified waterway
  corridor are added.
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DAMS_PATH = DATA_DIR / "dams.geojson"
WATERWAYS_PATH = DATA_DIR / "waterways.geojson"
OUTPUT_PATH = DATA_DIR / "earthquakes.geojson"
API = "https://earthquake.usgs.gov/fdsnws/event/1/query"
CORRIDOR_KM = 200.0
MIN_MAGNITUDE = 3.0
BOUNDS = {"minlatitude": 22.0, "maxlatitude": 36.5, "minlongitude": 94.0, "maxlongitude": 113.5}


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def haversine_km(a_lon: float, a_lat: float, b_lon: float, b_lat: float) -> float:
    radius = 6371.0088
    phi1, phi2 = math.radians(a_lat), math.radians(b_lat)
    dphi = math.radians(b_lat - a_lat)
    dlambda = math.radians(b_lon - a_lon)
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(h)))


def point_segment_km(lon: float, lat: float, start: list[float], end: list[float]) -> float:
    mean_lat = math.radians((lat + start[1] + end[1]) / 3)
    scale_x = 111.320 * math.cos(mean_lat)
    scale_y = 110.574
    px, py = (lon - start[0]) * scale_x, (lat - start[1]) * scale_y
    ex, ey = (end[0] - start[0]) * scale_x, (end[1] - start[1]) * scale_y
    denominator = ex * ex + ey * ey
    t = 0.0 if denominator == 0 else max(0.0, min(1.0, (px * ex + py * ey) / denominator))
    return math.hypot(px - t * ex, py - t * ey)


def fetch_chunk(start: datetime, end: datetime) -> list[dict]:
    params = {
        "format": "geojson", "starttime": iso_z(start), "endtime": iso_z(end),
        "minmagnitude": MIN_MAGNITUDE, "orderby": "time-asc", "limit": 20000,
        **BOUNDS,
    }
    request = urllib.request.Request(
        f"{API}?{urllib.parse.urlencode(params)}",
        headers={"User-Agent": "yangtze-dam-seismic-map/1.0", "Accept": "application/geo+json"},
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.load(response)
    return payload.get("features", [])


def load_context() -> tuple[list[dict], list[tuple[list[float], list[float]]]]:
    dams_geo = json.loads(DAMS_PATH.read_text(encoding="utf-8"))
    water_geo = json.loads(WATERWAYS_PATH.read_text(encoding="utf-8"))
    dams = [{
        "name": feature["properties"]["name"], "basin": feature["properties"]["basin"],
        "coordinates": feature["geometry"]["coordinates"],
    } for feature in dams_geo["features"]]
    segments = []
    for feature in water_geo["features"]:
        coords = feature["geometry"]["coordinates"]
        segments.extend(zip(coords, coords[1:]))
    return dams, list(segments)


def nearest_context(lon: float, lat: float, dams: list[dict], segments: list[tuple[list[float], list[float]]]) -> tuple[dict, float, float]:
    nearest = min(dams, key=lambda dam: haversine_km(lon, lat, dam["coordinates"][0], dam["coordinates"][1]))
    dam_distance = haversine_km(lon, lat, nearest["coordinates"][0], nearest["coordinates"][1])
    corridor_distance = min((point_segment_km(lon, lat, start, end) for start, end in segments), default=float("inf"))
    return nearest, dam_distance, corridor_distance


def normalize_event(feature: dict, dams: list[dict], segments: list[tuple[list[float], list[float]]]) -> dict | None:
    coordinates = feature.get("geometry", {}).get("coordinates", [])
    props = feature.get("properties", {})
    if len(coordinates) < 3 or props.get("mag") is None:
        return None
    lon, lat, depth = map(float, coordinates[:3])
    nearest, dam_km, corridor_km = nearest_context(lon, lat, dams, segments)
    if min(dam_km, corridor_km) > CORRIDOR_KM:
        return None
    timestamp = int(props["time"])
    return {
        "type": "Feature",
        "id": feature.get("id"),
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "eventId": feature.get("id"), "time": iso_z(datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc)),
            "timestamp": timestamp, "mag": float(props["mag"]), "magType": props.get("magType"),
            "depthKm": depth, "place": props.get("place"), "nearestDam": nearest["name"],
            "nearestDamKm": round(dam_km, 2), "nearestBasin": nearest["basin"],
            "corridorDistanceKm": round(corridor_km, 2), "source": "USGS FDSN Event Web Service",
            "url": props.get("url"), "updated": props.get("updated"),
        },
    }


def main() -> None:
    now = datetime.now(timezone.utc)
    existing_collection = {"type": "FeatureCollection", "features": []}
    if OUTPUT_PATH.exists():
        existing_collection = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    existing = {feature["properties"]["eventId"]: feature for feature in existing_collection.get("features", [])}

    force_start = os.getenv("EARTHQUAKE_FORCE_START")
    if force_start:
        start = parse_time(force_start)
    elif existing:
        latest = max(parse_time(feature["properties"]["time"]) for feature in existing.values())
        start = min(latest - timedelta(days=14), now - timedelta(days=14))
    else:
        start = parse_time(os.getenv("EARTHQUAKE_BOOTSTRAP_START", "2016-08-30T00:00:00Z"))

    dams, segments = load_context()
    cursor = start
    fetched = accepted = 0
    while cursor < now:
        chunk_end = min(cursor + timedelta(days=180), now)
        events = fetch_chunk(cursor, chunk_end)
        fetched += len(events)
        for raw in events:
            event = normalize_event(raw, dams, segments)
            if event:
                existing[event["properties"]["eventId"]] = event
                accepted += 1
        print(f"{iso_z(cursor)} → {iso_z(chunk_end)}: {len(events)} fetched")
        # Query boundaries may contain millisecond timestamps. Reuse the exact
        # endpoint and rely on event-id deduplication so no sub-second gap forms.
        cursor = chunk_end
        time.sleep(0.15)

    features = sorted(existing.values(), key=lambda feature: feature["properties"]["timestamp"])
    output = {
        "type": "FeatureCollection", "generatedAt": iso_z(now),
        "retentionPolicy": "append-and-revise; never delete by age",
        "filterNote": "M3.0+ and within 200 km of a selected dam or simplified waterway corridor",
        "features": features,
    }
    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Fetched {fetched}; accepted/revised {accepted}; retained {len(features)} total events")


if __name__ == "__main__":
    main()
