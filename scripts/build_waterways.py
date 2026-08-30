#!/usr/bin/env python3
"""Build simplified river corridors by joining verified dam map points.

The lines are a visual/spatial index rather than survey-grade river centerlines.
This limitation is recorded in the GeoJSON metadata and README.
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DAMS_PATH = ROOT / "data" / "dams.geojson"
OUTPUT_PATH = ROOT / "data" / "waterways.geojson"

ROUTES = {
    "长江—金沙江干流": ["liyuan", "ahai", "jinanqiao", "longkaikou", "ludila", "guanyinyan", "wudongde", "baihetan", "xiluodu", "xiangjiaba", "three-gorges"],
    "雅砻江": ["lianghekou", "yangfanggou", "jinping-i", "jinping-ii", "guandi", "ertan", "tongzilin", "wudongde"],
    "大渡河": ["houziyan", "dagangshan", "pubugou", "shenxigou", "zhentouba-i", "shaping-ii", "gongzui", "tongjiezi", "xiangjiaba"],
    "岷江": ["zipingpu", "xiangjiaba"],
    "嘉陵江": ["bikou", "baozhusi", "tingzikou", "caojie", "three-gorges"],
    "乌江": ["hongjiadu", "dongfeng", "suofengying", "wujiangdu", "goupitan", "silin", "shatuo", "pengshui", "three-gorges"],
}


def main() -> None:
    dams = json.loads(DAMS_PATH.read_text(encoding="utf-8"))
    points = {feature["properties"]["id"]: feature["geometry"]["coordinates"] for feature in dams["features"]}
    features = []
    for name, route in ROUTES.items():
        coordinates = [points[dam_id] for dam_id in route if dam_id in points]
        if len(coordinates) < 2:
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coordinates},
            "properties": {"name": name, "geometryQuality": "simplified-dam-to-dam corridor"},
        })
    output = {
        "type": "FeatureCollection",
        "geometryNote": "水道线由水坝定位点顺序连接，仅用于区域尺度展示和200公里走廊筛选，不是测绘级河道中心线。",
        "features": features,
    }
    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(features)} waterway corridors to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
