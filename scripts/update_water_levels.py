#!/usr/bin/env python3
from __future__ import annotations

import html
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "water-levels.json"
SOURCE_URL = "https://sanxiatansuo.com/jsdata/key_redis.php?index=waterlist"
OFFICIAL_REFERENCE_URL = "https://www.cjh.com.cn/swyb_sssq.html"
PAGES_TO_FETCH = 15
ROW_PATTERN = re.compile(
    r"上游水位.*?</td><td[^>]*>\s*([0-9.]+)\s*</td><td[^>]*>\s*([0-9/]+)\s*</td>",
    re.IGNORECASE | re.DOTALL,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_existing() -> dict:
    if not OUTPUT.exists():
        return {"schemaVersion": 1, "comparisonDays": 30, "dams": {}}
    return json.loads(OUTPUT.read_text(encoding="utf-8"))


def fetch_page(page: int) -> str:
    separator = "&" if "?" in SOURCE_URL else "?"
    url = f"{SOURCE_URL}{separator}curpage={page}"
    request = Request(
        url,
        headers={
            "User-Agent": "YangtzeDamSeismicMap/1.0 (+GitHub Pages research project)",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urlopen(request, timeout=35) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_records(document: str) -> list[dict]:
    records = []
    for level_text, date_text in ROW_PATTERN.findall(html.unescape(document)):
        try:
            observed = datetime.strptime(date_text, "%m/%d/%Y").date().isoformat()
            level = round(float(level_text), 2)
        except ValueError:
            continue
        if not 0 < level < 4000:
            continue
        records.append(
            {
                "date": observed,
                "levelM": level,
                "sourceId": "sanxiatansuo-waterlist",
                "observationType": "第三方页面每日汇总值",
            }
        )
    return records


def merge_monthly_last(existing: list[dict], daily_records: list[dict]) -> list[dict]:
    """Keep one real observation per month: the latest dated, verifiable record."""
    monthly = {
        item["month"]: item
        for item in existing
        if item.get("month") and item.get("date") and item.get("levelM") is not None
    }
    for record in daily_records:
        month = record["date"][:7]
        candidate = {
            "month": month,
            "date": record["date"],
            "levelM": record["levelM"],
            "sourceId": record["sourceId"],
            "observationType": "月内最后一个可核验日值",
        }
        if month not in monthly or candidate["date"] >= monthly[month]["date"]:
            monthly[month] = candidate
    return [monthly[key] for key in sorted(monthly)]


def main() -> None:
    checked_at = utc_now()
    fetched: dict[str, dict] = {}
    page_errors = []
    for page in range(1, PAGES_TO_FETCH + 1):
        try:
            for record in parse_records(fetch_page(page)):
                fetched[record["date"]] = record
        except Exception as exc:  # A later page failure must not discard successful pages.
            page_errors.append(f"page {page}: {exc}")
        if page < PAGES_TO_FETCH:
            time.sleep(0.15)

    if not fetched:
        raise RuntimeError("No Three Gorges daily water-level records were parsed; refusing to overwrite data")

    data = read_existing()
    dams = data.setdefault("dams", {})
    existing_records = {
        item["date"]: item
        for item in dams.get("three-gorges", {}).get("records", [])
        if item.get("date") and item.get("levelM") is not None
    }
    existing_records.update(fetched)
    merged = [existing_records[key] for key in sorted(existing_records)]

    previous_entry = dams.get("three-gorges", {})
    dams["three-gorges"] = {
        "status": "available",
        "stationName": "三峡水库上游水位",
        "samplePolicy": "每日一个页面汇总值；展示时以最新可获得记录日为锚点",
        "latestAvailableDate": merged[-1]["date"],
        "lastCheckedAt": checked_at,
        "records": merged,
        "monthlyRecords": merge_monthly_last(previous_entry.get("monthlyRecords", []), merged),
    }
    data.update(
        {
            "schemaVersion": 1,
            "comparisonDays": 30,
            "generatedAt": checked_at,
            "sources": {
                "sanxiatansuo-waterlist": {
                    "title": "三峡探索·水情信息",
                    "url": SOURCE_URL,
                    "tier": "第三方汇总",
                    "licence": "页面未声明开放数据许可",
                    "note": "记录不可视为官方发布值；页面提供三峡上游水位日记录。",
                    "retrievedAt": checked_at,
                },
                "cjh-official-reference": {
                    "title": "长江水文网·实时水情",
                    "url": OFFICIAL_REFERENCE_URL,
                    "tier": "官方参考",
                    "note": "用于人工交叉核验，不在本项目中自动复制其受限数据。",
                },
            },
            "coverageNote": "所有水坝均展示水位图表组件；仅有可核验日记录的水坝绘制曲线，禁止模拟或插值补齐。",
            "fetchWarnings": page_errors,
        }
    )
    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Merged {len(fetched)} fetched Three Gorges records; "
        f"archive now has {len(merged)} records through {merged[-1]['date']}"
    )
    if page_errors:
        print("Warnings: " + " | ".join(page_errors))


if __name__ == "__main__":
    main()
