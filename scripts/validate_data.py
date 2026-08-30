#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OFFICIAL_SOURCE_DOMAINS = ("ctg.com.cn", "ylhdc.com.cn", "chnenergy.com.cn", "mee.gov.cn", "nea.gov.cn", "chd.com.cn")
BASIN_BOUNDS = {
    "长江—金沙江干流": (99.0, 112.0, 25.0, 32.0),
    "雅砻江": (100.0, 103.0, 26.0, 31.5),
    "大渡河": (101.0, 104.0, 28.5, 32.0),
    "岷江": (102.5, 104.5, 29.5, 32.5),
    "嘉陵江": (104.0, 108.0, 29.0, 34.0),
    "乌江": (105.0, 110.0, 25.5, 30.5),
}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    dams = json.loads((DATA / "dams.geojson").read_text(encoding="utf-8"))
    earthquakes = json.loads((DATA / "earthquakes.geojson").read_text(encoding="utf-8"))
    water_levels_path = DATA / "water-levels.json"
    water_levels = json.loads(water_levels_path.read_text(encoding="utf-8")) if water_levels_path.exists() else {"dams": {}}
    required = {"id", "name", "basin", "normalLevelM", "damHeightM", "totalStorageBillionM3", "normalAreaKm2", "sourceTitle", "sourceUrl", "sourceDate"}
    ids = set()
    for feature in dams.get("features", []):
        props = feature.get("properties", {})
        missing = required - set(props)
        if missing:
            fail(f"{props.get('name', 'unknown')} missing keys: {sorted(missing)}")
        if props["id"] in ids:
            fail(f"duplicate dam id: {props['id']}")
        ids.add(props["id"])
        coordinates = feature.get("geometry", {}).get("coordinates", [])
        if len(coordinates) != 2 or not (73 <= coordinates[0] <= 135 and 18 <= coordinates[1] <= 54):
            fail(f"invalid coordinates: {props['name']} {coordinates}")
        bounds = BASIN_BOUNDS.get(props["basin"])
        if bounds and not (bounds[0] <= coordinates[0] <= bounds[1] and bounds[2] <= coordinates[1] <= bounds[3]):
            fail(f"coordinates outside basin bounds: {props['name']} {coordinates}")
        if not str(props["sourceUrl"]).startswith("https://"):
            fail(f"non-HTTPS source: {props['name']}")
        hostname = (urlparse(props["sourceUrl"]).hostname or "").lower()
        if not any(hostname == domain or hostname.endswith("." + domain) for domain in OFFICIAL_SOURCE_DOMAINS):
            fail(f"source is not on the approved official-domain list: {props['name']} {hostname}")
        for field in ("normalLevelM", "damHeightM", "totalStorageBillionM3", "normalAreaKm2"):
            value = props[field]
            if value is not None and float(value) <= 0:
                fail(f"invalid non-positive {field}: {props['name']} {value}")

    event_ids = set()
    for feature in earthquakes.get("features", []):
        props = feature.get("properties", {})
        event_id = props.get("eventId")
        if not event_id or event_id in event_ids:
            fail(f"missing or duplicate earthquake id: {event_id}")
        event_ids.add(event_id)

    water_record_count = 0
    for dam_id, entry in water_levels.get("dams", {}).items():
        if dam_id not in ids:
            fail(f"water-level data references unknown dam id: {dam_id}")
        seen_dates = set()
        for record in entry.get("records", []):
            day = record.get("date")
            if not day or day in seen_dates:
                fail(f"missing or duplicate water-level date: {dam_id} {day}")
            try:
                datetime.strptime(day, "%Y-%m-%d")
                level = float(record["levelM"])
            except (KeyError, TypeError, ValueError):
                fail(f"invalid water-level record: {dam_id} {record}")
            if not 0 < level < 4000:
                fail(f"water level outside sanity bounds: {dam_id} {day} {level}")
            seen_dates.add(day)
            water_record_count += 1
        seen_months = set()
        for record in entry.get("monthlyRecords", []):
            month = record.get("month")
            day = record.get("date")
            if not month or month in seen_months or not day or not day.startswith(month):
                fail(f"invalid or duplicate monthly water-level record: {dam_id} {record}")
            try:
                datetime.strptime(month, "%Y-%m")
                datetime.strptime(day, "%Y-%m-%d")
                level = float(record["levelM"])
            except (KeyError, TypeError, ValueError):
                fail(f"invalid monthly water-level value: {dam_id} {record}")
            if not 0 < level < 4000:
                fail(f"monthly water level outside sanity bounds: {dam_id} {month} {level}")
            seen_months.add(month)

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    recent = sum(now_ms - int(feature["properties"]["timestamp"]) <= 30 * 86400 * 1000 for feature in earthquakes.get("features", []))
    update_candidates = [value for value in (earthquakes.get("generatedAt"), water_levels.get("generatedAt")) if value]
    metadata = {
        "updatedAt": max(update_candidates) if update_candidates else datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "damCount": len(ids), "earthquakeCount": len(event_ids), "recent30DayCount": recent,
        "waterLevelRecordCount": water_record_count,
        "waterLevelUpdatedAt": water_levels.get("generatedAt"),
        "note": "地震与水位记录永久保留；最近30天地震由前端动态高亮，水位缺失日不插值。",
    }
    (DATA / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Validated {len(ids)} dams, {len(event_ids)} earthquakes and {water_record_count} water-level records; {recent} recent earthquakes")


if __name__ == "__main__":
    main()
