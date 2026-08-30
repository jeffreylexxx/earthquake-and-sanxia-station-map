const DATA_PATHS = {
  dams: "./data/dams.geojson",
  earthquakes: "./data/earthquakes.geojson",
  waterways: "./data/waterways.geojson",
  waterLevels: "./data/water-levels.json",
  metadata: "./data/metadata.json",
};

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY_COLLECTION = { type: "FeatureCollection", features: [] };

const appState = {
  dams: EMPTY_COLLECTION,
  earthquakes: EMPTY_COLLECTION,
  waterways: EMPTY_COLLECTION,
  waterLevels: { comparisonDays: 30, dams: {}, sources: {} },
  metadata: {},
  map: null,
  filters: { magnitude: 3, maxDepth: 100, startYear: "all", basin: "all" },
};
let damHoverPopup = null;

const dom = Object.fromEntries(
  [
    "lastUpdated", "damCount", "quakeCount", "recentCount", "maxMagnitude",
    "toggleDams", "toggleQuakes", "toggleRecent", "toggleWaterways",
    "magnitudeRange", "magnitudeValue", "depthRange", "depthValue",
    "yearSelect", "basinSelect", "resetFilters", "detailDrawer", "drawerClose",
    "detailType", "detailTitle", "detailKicker", "detailBody", "loadingScreen",
    "mobileFilterButton",
  ].map((id) => [id, document.getElementById(id)])
);

function rasterStyle() {
  return {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#dce3df" } },
      {
        id: "osm",
        type: "raster",
        source: "osm",
        paint: { "raster-saturation": -0.72, "raster-contrast": 0.08, "raster-brightness-min": 0.22, "raster-brightness-max": 0.95 },
      },
    ],
  };
}

async function loadJson(path, fallback = EMPTY_COLLECTION) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}`);
  return response.json().catch(() => fallback);
}

function isRecent(feature) {
  const time = Number(feature.properties?.timestamp || Date.parse(feature.properties?.time));
  const age = Date.now() - time;
  return Number.isFinite(time) && age >= 0 && age <= MONTH_MS;
}

function isPreviousMonth(feature) {
  const time = Number(feature.properties?.timestamp || Date.parse(feature.properties?.time));
  const age = Date.now() - time;
  return Number.isFinite(time) && age > MONTH_MS && age <= MONTH_MS * 2;
}

function isThirdMonth(feature) {
  const time = Number(feature.properties?.timestamp || Date.parse(feature.properties?.time));
  const age = Date.now() - time;
  return Number.isFinite(time) && age > MONTH_MS * 2 && age <= MONTH_MS * 3;
}

function filteredDams() {
  if (appState.filters.basin === "all") return appState.dams;
  return {
    ...appState.dams,
    features: appState.dams.features.filter((feature) => feature.properties.basin === appState.filters.basin),
  };
}

function filteredEarthquakes() {
  const { magnitude, maxDepth, startYear, basin } = appState.filters;
  return {
    ...appState.earthquakes,
    features: appState.earthquakes.features.filter((feature) => {
      const props = feature.properties || {};
      const year = new Date(props.time || props.timestamp).getUTCFullYear();
      return Number(props.mag) >= magnitude
        && Number(props.depthKm) <= maxDepth
        && (startYear === "all" || year >= Number(startYear))
        && (basin === "all" || props.nearestBasin === basin);
    }),
  };
}

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || value === "") return "官方公开资料未查得";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

function formatDate(value, withTime = false) {
  if (!value) return "未注明";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false } : {}),
  }).format(date);
}

function detailRows(rows) {
  return `<dl class="detail-list">${rows.map(([label, value]) => `
    <div class="detail-row"><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseIsoDay(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function shiftUtcDay(date, days) {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function shiftUtcYear(date, years) {
  const shifted = new Date(date);
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  return shifted;
}

function chartPath(points, xScale, yScale) {
  let drawing = false;
  return points.map((point, index) => {
    if (!point) {
      drawing = false;
      return "";
    }
    const command = drawing ? "L" : "M";
    drawing = true;
    return `${command}${xScale(index).toFixed(1)},${yScale(point.levelM).toFixed(1)}`;
  }).join(" ");
}

function waterLevelChart(damId, normalLevelM) {
  const entry = appState.waterLevels.dams?.[damId];
  if (!entry?.records?.length) {
    return `<section class="water-chart-card water-chart-empty" aria-label="水库运行水位暂无数据">
      <div class="chart-heading"><div><p class="chart-label">水库运行水位</p><h3>30 日同比</h3></div><span class="data-status status-empty">暂无日记录</span></div>
      <div class="empty-plot" aria-hidden="true"><span style="--normal-position:58%"></span></div>
      <p>尚未找到可持续自动获取且能够核验的公开日水位数据。</p>
      <p class="normal-level-note">正常蓄水位参考：${formatNumber(normalLevelM)} m</p>
    </section>`;
  }

  const days = Number(appState.waterLevels.comparisonDays || 30);
  const records = [...entry.records].sort((a, b) => a.date.localeCompare(b.date));
  const recordByDate = new Map(records.map((record) => [record.date, record]));
  const anchor = parseIsoDay(entry.latestAvailableDate || records.at(-1).date);
  const current = [];
  const previous = [];
  const dates = [];
  for (let index = 0; index < days; index += 1) {
    const day = shiftUtcDay(anchor, index - (days - 1));
    const previousDay = shiftUtcYear(day, -1);
    dates.push(day);
    current.push(recordByDate.get(isoDay(day)) || null);
    previous.push(recordByDate.get(isoDay(previousDay)) || null);
  }

  const values = [...current, ...previous].filter(Boolean).map((record) => Number(record.levelM));
  if (normalLevelM != null) values.push(Number(normalLevelM));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max(1, (rawMax - rawMin) * 0.08);
  const yMin = Math.floor((rawMin - padding) * 10) / 10;
  const yMax = Math.ceil((rawMax + padding) * 10) / 10;
  const width = 420;
  const height = 238;
  const plot = { left: 44, right: 12, top: 18, bottom: 42 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const xScale = (index) => plot.left + (index / Math.max(1, days - 1)) * plotWidth;
  const yScale = (value) => plot.top + ((yMax - value) / Math.max(0.01, yMax - yMin)) * plotHeight;
  const ticks = Array.from({ length: 4 }, (_, index) => yMin + ((yMax - yMin) * index) / 3).reverse();
  const xTickIndexes = [0, 9, 19, days - 1].filter((value, index, array) => value >= 0 && array.indexOf(value) === index);
  const source = appState.waterLevels.sources?.[current.find(Boolean)?.sourceId || previous.find(Boolean)?.sourceId] || {};
  const freshnessDays = Math.max(0, Math.floor((Date.now() - anchor.getTime()) / 86400000));
  const statusText = freshnessDays <= 2 ? "数据较新" : `延迟 ${freshnessDays} 天`;
  const statusClass = freshnessDays <= 2 ? "status-current" : "status-stale";

  const pointHits = [...current.map((record, index) => ({ record, index, series: "最近30日" })),
    ...previous.map((record, index) => ({ record, index, series: "去年同期" }))]
    .filter((item) => item.record)
    .map((item) => `<circle class="chart-hit" tabindex="0" cx="${xScale(item.index).toFixed(1)}" cy="${yScale(item.record.levelM).toFixed(1)}" r="10"
      data-date="${escapeHtml(item.record.date)}" data-level="${escapeHtml(item.record.levelM)}" data-series="${item.series}" aria-label="${item.series} ${item.record.date} ${item.record.levelM} 米"></circle>`).join("");

  return `<section class="water-chart-card" aria-label="水库运行水位30日同比曲线">
    <div class="chart-heading"><div><p class="chart-label">水库运行水位</p><h3>30 日同比</h3></div><span class="data-status ${statusClass}">${statusText}</span></div>
    <div class="chart-legend" aria-hidden="true"><span><i class="line-current"></i>最近30日</span><span><i class="line-previous"></i>去年同期</span><span><i class="line-normal"></i>正常蓄水位</span></div>
    <div class="chart-shell">
      <svg class="water-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${formatDate(isoDay(dates[0]))}至${formatDate(isoDay(anchor))}水位及去年同期对比">
        ${ticks.map((tick) => `<line class="chart-grid" x1="${plot.left}" x2="${width - plot.right}" y1="${yScale(tick)}" y2="${yScale(tick)}"></line><text class="axis-label" x="${plot.left - 8}" y="${yScale(tick) + 3}" text-anchor="end">${tick.toFixed(1)}</text>`).join("")}
        ${xTickIndexes.map((index) => `<text class="axis-label" x="${xScale(index)}" y="${height - 17}" text-anchor="middle">${dates[index].getUTCMonth() + 1}/${dates[index].getUTCDate()}</text>`).join("")}
        ${normalLevelM == null ? "" : `<line class="normal-line" x1="${plot.left}" x2="${width - plot.right}" y1="${yScale(normalLevelM)}" y2="${yScale(normalLevelM)}"></line><text class="normal-label" x="${width - plot.right}" y="${Math.max(11, yScale(normalLevelM) - 5)}" text-anchor="end">正常 ${formatNumber(normalLevelM)} m</text>`}
        <path class="series-line series-previous" d="${chartPath(previous, xScale, yScale)}"></path>
        <path class="series-line series-current" d="${chartPath(current, xScale, yScale)}"></path>
        ${pointHits}
      </svg>
      <div class="chart-tooltip" role="status" aria-live="polite"></div>
    </div>
    <div class="chart-foot"><span>${formatDate(isoDay(dates[0]))} — ${formatDate(isoDay(anchor))}</span><span>${current.filter(Boolean).length}/${days} 个日值</span></div>
    <p class="chart-source-note">${escapeHtml(entry.samplePolicy || "每日一条记录")} · ${escapeHtml(source.tier || "来源未分级")}<br>最近检查：${formatDate(entry.lastCheckedAt, true)}</p>
    ${source.url ? `<a class="source-link compact-link" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">查看水位数据来源：${escapeHtml(source.title || "原始页面")}</a>` : ""}
  </section>`;
}

function bindChartTooltip() {
  const shell = dom.detailBody.querySelector(".chart-shell");
  const tooltip = shell?.querySelector(".chart-tooltip");
  if (!shell || !tooltip) return;
  const show = (target) => {
    const rect = shell.getBoundingClientRect();
    const pointRect = target.getBoundingClientRect();
    tooltip.innerHTML = `<strong>${target.dataset.level} m</strong><span>${target.dataset.series} · ${formatDate(target.dataset.date)}</span>`;
    tooltip.style.left = `${pointRect.left - rect.left}px`;
    tooltip.style.top = `${pointRect.top - rect.top}px`;
    tooltip.classList.add("is-visible");
  };
  shell.querySelectorAll(".chart-hit").forEach((target) => {
    target.addEventListener("pointerenter", () => show(target));
    target.addEventListener("focus", () => show(target));
    target.addEventListener("pointerleave", () => tooltip.classList.remove("is-visible"));
    target.addEventListener("blur", () => tooltip.classList.remove("is-visible"));
  });
}

function latestWaterObservation(damId) {
  const entry = appState.waterLevels.dams?.[damId];
  if (!entry) return null;
  const observations = [
    ...(entry.records || []),
    ...(entry.monthlyRecords || []),
  ].filter((record) => record?.date && record?.levelM != null);
  return observations.sort((a, b) => a.date.localeCompare(b.date)).at(-1) || null;
}

function waterLevelSummary(damId, normalLevelM) {
  const observation = latestWaterObservation(damId);
  const source = observation ? appState.waterLevels.sources?.[observation.sourceId] : null;
  return `<section class="level-summary" aria-label="水位摘要">
    <div class="level-summary-item">
      <span>正常蓄水位参考</span>
      <strong>${normalLevelM == null ? "—" : `${formatNumber(normalLevelM)} <small>m</small>`}</strong>
      <em>工程设计参数</em>
    </div>
    <div class="level-summary-item current-level-item">
      <span>目前水位</span>
      <strong>${observation ? `${formatNumber(observation.levelM, 2)} <small>m</small>` : "—"}</strong>
      <em>${observation ? `最近可核验 · ${formatDate(observation.date)}${source?.tier ? ` · ${escapeHtml(source.tier)}` : ""}` : "暂无可核验近期记录"}</em>
    </div>
  </section>`;
}

function currentShanghaiYear() {
  return Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric" }).format(new Date()));
}

function annualWaterLevelChart(damId, normalLevelM) {
  const year = currentShanghaiYear();
  const entry = appState.waterLevels.dams?.[damId];
  const records = (entry?.monthlyRecords || []).filter((record) => Number(String(record.month || record.date).slice(0, 4)) === year);
  const byMonth = new Map(records.map((record) => [Number(String(record.month || record.date).slice(5, 7)), record]));
  const months = Array.from({ length: 12 }, (_, index) => byMonth.get(index + 1) || null);
  const available = months.filter(Boolean);
  if (!available.length) {
    return `<section class="water-chart-card annual-chart-card water-chart-empty" aria-label="${year}年月度运行水位暂无数据">
      <div class="chart-heading"><div><p class="chart-label">水库运行水位</p><h3>${year} 年月度曲线</h3></div><span class="data-status status-empty">0 / 12 月</span></div>
      <div class="annual-empty-plot" aria-hidden="true">
        <div class="annual-month-axis">${Array.from({ length: 12 }, (_, index) => `<span>${index + 1}月</span>`).join("")}</div>
      </div>
      <p>尚未找到本年度可持续获取且能够核验的月度运行水位。后续只在获得真实记录时逐月更新。</p>
      <p class="normal-level-note">正常蓄水位参考：${formatNumber(normalLevelM)} m</p>
    </section>`;
  }

  const values = available.map((record) => Number(record.levelM));
  if (normalLevelM != null) values.push(Number(normalLevelM));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max(1, (rawMax - rawMin) * 0.1);
  const yMin = Math.floor((rawMin - padding) * 10) / 10;
  const yMax = Math.ceil((rawMax + padding) * 10) / 10;
  const width = 420;
  const height = 230;
  const plot = { left: 44, right: 12, top: 18, bottom: 40 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const xScale = (index) => plot.left + (index / 11) * plotWidth;
  const yScale = (value) => plot.top + ((yMax - value) / Math.max(0.01, yMax - yMin)) * plotHeight;
  const ticks = Array.from({ length: 4 }, (_, index) => yMin + ((yMax - yMin) * index) / 3).reverse();
  const sourceIds = [...new Set(available.map((record) => record.sourceId).filter(Boolean))];
  const sources = sourceIds.map((id) => appState.waterLevels.sources?.[id]).filter(Boolean);
  const hits = months.map((record, index) => record ? `<circle class="chart-hit" tabindex="0" cx="${xScale(index).toFixed(1)}" cy="${yScale(record.levelM).toFixed(1)}" r="10"
    data-date="${escapeHtml(record.date)}" data-level="${escapeHtml(record.levelM)}" data-series="${index + 1}月月末可核验值" aria-label="${index + 1}月 ${record.date} ${record.levelM} 米"></circle>` : "").join("");

  return `<section class="water-chart-card annual-chart-card" aria-label="${year}年月度运行水位曲线">
    <div class="chart-heading"><div><p class="chart-label">水库运行水位</p><h3>${year} 年月度曲线</h3></div><span class="data-status status-current">${available.length} / 12 月</span></div>
    <div class="chart-legend" aria-hidden="true"><span><i class="line-current"></i>每月最后一个可核验值</span><span><i class="line-normal"></i>正常蓄水位</span></div>
    <div class="chart-shell">
      <svg class="water-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${year}年一月至十二月运行水位">
        ${ticks.map((tick) => `<line class="chart-grid" x1="${plot.left}" x2="${width - plot.right}" y1="${yScale(tick)}" y2="${yScale(tick)}"></line><text class="axis-label" x="${plot.left - 8}" y="${yScale(tick) + 3}" text-anchor="end">${tick.toFixed(1)}</text>`).join("")}
        ${Array.from({ length: 12 }, (_, index) => `<text class="axis-label" x="${xScale(index)}" y="${height - 16}" text-anchor="middle">${index + 1}</text>`).join("")}
        ${normalLevelM == null ? "" : `<line class="normal-line" x1="${plot.left}" x2="${width - plot.right}" y1="${yScale(normalLevelM)}" y2="${yScale(normalLevelM)}"></line><text class="normal-label" x="${width - plot.right}" y="${Math.max(11, yScale(normalLevelM) - 5)}" text-anchor="end">正常 ${formatNumber(normalLevelM)} m</text>`}
        <path class="series-line series-current" d="${chartPath(months, xScale, yScale)}"></path>
        ${available.map((record) => `<circle class="series-dot" cx="${xScale(Number(String(record.month || record.date).slice(5, 7)) - 1)}" cy="${yScale(record.levelM)}" r="3.2"></circle>`).join("")}
        ${hits}
      </svg>
      <div class="chart-tooltip" role="status" aria-live="polite"></div>
    </div>
    <div class="chart-foot"><span>统计口径：月内最后一个可核验观测值</span><span>${available.length}/12 个月</span></div>
    <p class="chart-source-note">缺失月份保持断点，不平均、不插值、不模拟。${entry?.lastCheckedAt ? `<br>最近检查：${formatDate(entry.lastCheckedAt, true)}` : ""}</p>
    ${sources.map((source) => source.url ? `<a class="source-link compact-link" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">查看月度水位来源：${escapeHtml(source.title || "原始页面")}</a>` : "").join("")}
  </section>`;
}

function openDamDetail(feature) {
  const props = feature.properties;
  dom.detailType.textContent = "DAM / RESERVOIR";
  dom.detailTitle.textContent = props.name;
  dom.detailKicker.textContent = props.basin;
  const engineeringDetails = waterLevelSummary(props.id, props.normalLevelM) + detailRows([
    ["最大坝高", `${formatNumber(props.damHeightM)} m`],
    ["总库容", `${formatNumber(props.totalStorageBillionM3, 3)} 十亿 m³`],
    ["正常蓄水面积", props.normalAreaKm2 == null ? "官方公开资料未查得" : `${formatNumber(props.normalAreaKm2, 2)} km²`],
    ["工程资料发布日期", props.sourceDate || "官方资料未注明"],
  ]) + (props.sourceUrl
    ? `<a class="source-link" href="${props.sourceUrl}" target="_blank" rel="noreferrer">查看工程参数官方来源：${props.sourceTitle || "原始资料"}</a>`
    : "");
  dom.detailBody.innerHTML = props.id === "three-gorges"
    ? waterLevelChart(props.id, props.normalLevelM) + engineeringDetails
    : engineeringDetails + annualWaterLevelChart(props.id, props.normalLevelM);
  showDrawer();
  bindChartTooltip();
}

function openQuakeDetail(feature) {
  const props = feature.properties;
  const recentBadge = isRecent(feature) ? '<span class="new-badge">近30天新增</span>' : "";
  dom.detailType.textContent = "EARTHQUAKE EVENT";
  dom.detailTitle.innerHTML = `M ${formatNumber(props.mag)}${recentBadge}`;
  dom.detailKicker.textContent = props.place || "震中参考位置未注明";
  dom.detailBody.innerHTML = detailRows([
    ["发震日期（北京时间）", formatDate(props.time, true)],
    ["震级类型", props.magType || "未注明"],
    ["震源深度", `${formatNumber(props.depthKm)} km`],
    ["最近水坝", props.nearestDam || "未计算"],
    ["距最近水坝", props.nearestDamKm == null ? "未计算" : `${formatNumber(props.nearestDamKm)} km`],
    ["数据来源", props.source || "未注明"],
  ]) + (props.url
    ? `<a class="source-link" href="${props.url}" target="_blank" rel="noreferrer">查看地震目录原始记录</a>`
    : "");
  showDrawer();
}

function showDrawer() {
  dom.detailDrawer.classList.add("is-open");
  dom.detailDrawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  dom.detailDrawer.classList.remove("is-open");
  dom.detailDrawer.setAttribute("aria-hidden", "true");
}

function addMapData() {
  const map = appState.map;
  map.addSource("waterways", { type: "geojson", data: appState.waterways });
  map.addLayer({
    id: "waterways-line", type: "line", source: "waterways",
    paint: { "line-color": "#168d9a", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.3, 7, 2.8], "line-opacity": 0.82 },
  });

  map.addSource("earthquakes", { type: "geojson", data: appState.earthquakes, cluster: true, clusterRadius: 42, clusterMaxZoom: 8 });
  map.addSource("recent-earthquakes", {
    type: "geojson",
    data: { ...appState.earthquakes, features: appState.earthquakes.features.filter(isRecent) },
  });
  map.addSource("previous-month-earthquakes", {
    type: "geojson",
    data: { ...appState.earthquakes, features: appState.earthquakes.features.filter(isPreviousMonth) },
  });
  map.addSource("third-month-earthquakes", {
    type: "geojson",
    data: { ...appState.earthquakes, features: appState.earthquakes.features.filter(isThirdMonth) },
  });
  map.addLayer({
    id: "quake-clusters", type: "circle", source: "earthquakes", filter: ["has", "point_count"],
    paint: {
      "circle-color": ["step", ["get", "point_count"], "#df8b58", 50, "#d96a45", 200, "#a84343"],
      "circle-radius": ["step", ["get", "point_count"], 15, 50, 20, 200, 27],
      "circle-stroke-color": "rgba(242,240,233,.9)", "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "quake-cluster-count", type: "symbol", source: "earthquakes", filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 10 },
    paint: { "text-color": "#fff8ed" },
  });
  map.addLayer({
    id: "third-month-halo", type: "circle", source: "third-month-earthquakes",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 3, 7, 7, 20],
      "circle-color": "rgba(75,155,108,.1)", "circle-stroke-color": "#4b9b6c", "circle-stroke-width": 2, "circle-blur": .04,
    },
  });
  map.addLayer({
    id: "previous-month-halo", type: "circle", source: "previous-month-earthquakes",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 3, 8, 7, 22],
      "circle-color": "rgba(77,114,201,.1)", "circle-stroke-color": "#4d72c9", "circle-stroke-width": 2, "circle-blur": .05,
    },
  });
  map.addLayer({
    id: "recent-halo", type: "circle", source: "recent-earthquakes",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 3, 10, 7, 24],
      "circle-color": "rgba(255,180,59,.12)", "circle-stroke-color": "#ffb43b", "circle-stroke-width": 2, "circle-blur": .08,
    },
  });
  map.addLayer({
    id: "quake-points", type: "circle", source: "earthquakes", filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 3, 3.5, 5, 8, 7, 15],
      "circle-color": ["interpolate", ["linear"], ["get", "depthKm"], 0, "#ef6a3a", 35, "#cf4e42", 100, "#84475b", 300, "#3c365d"],
      "circle-opacity": .8, "circle-stroke-color": "rgba(255,255,255,.7)", "circle-stroke-width": .7,
    },
  });

  map.addSource("dams", { type: "geojson", data: appState.dams });
  map.addLayer({
    id: "dam-halos", type: "circle", source: "dams",
    paint: { "circle-radius": 10, "circle-color": "rgba(7,93,115,.13)", "circle-stroke-color": "rgba(7,93,115,.28)", "circle-stroke-width": 1 },
  });
  map.addLayer({
    id: "dam-points", type: "circle", source: "dams",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 4, 8, 7], "circle-color": "#075d73", "circle-stroke-color": "#f2f0e9", "circle-stroke-width": 1.5 },
  });
  map.on("click", "dam-points", (event) => openDamDetail(event.features[0]));
  map.on("click", "quake-points", (event) => openQuakeDetail(event.features[0]));
  map.on("click", "recent-halo", (event) => openQuakeDetail(event.features[0]));
  map.on("click", "quake-clusters", async (event) => {
    const feature = event.features[0];
    const zoom = await map.getSource("earthquakes").getClusterExpansionZoom(feature.properties.cluster_id);
    map.easeTo({ center: feature.geometry.coordinates, zoom });
  });
  map.on("mouseenter", "dam-points", (event) => {
    const feature = event.features[0];
    damHoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 })
      .setLngLat(feature.geometry.coordinates)
      .setHTML(`<strong>${feature.properties.name}</strong><br><small>点击查看工程参数</small>`)
      .addTo(map);
  });
  map.on("mouseleave", "dam-points", () => {
    if (damHoverPopup) damHoverPopup.remove();
    damHoverPopup = null;
  });
  ["dam-points", "quake-points", "recent-halo", "quake-clusters"].forEach((layer) => {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = "crosshair"; });
  });
}

function updateSourcesAndStats() {
  const dams = filteredDams();
  const quakes = filteredEarthquakes();
  if (appState.map?.getSource("dams")) appState.map.getSource("dams").setData(dams);
  if (appState.map?.getSource("earthquakes")) appState.map.getSource("earthquakes").setData(quakes);
  if (appState.map?.getSource("recent-earthquakes")) {
    appState.map.getSource("recent-earthquakes").setData({ ...quakes, features: quakes.features.filter(isRecent) });
  }
  if (appState.map?.getSource("previous-month-earthquakes")) {
    appState.map.getSource("previous-month-earthquakes").setData({ ...quakes, features: quakes.features.filter(isPreviousMonth) });
  }
  if (appState.map?.getSource("third-month-earthquakes")) {
    appState.map.getSource("third-month-earthquakes").setData({ ...quakes, features: quakes.features.filter(isThirdMonth) });
  }
  const magnitudes = quakes.features.map((feature) => Number(feature.properties.mag)).filter(Number.isFinite);
  dom.damCount.textContent = dams.features.length.toLocaleString("zh-CN");
  dom.quakeCount.textContent = quakes.features.length.toLocaleString("zh-CN");
  dom.recentCount.textContent = quakes.features.filter(isRecent).length.toLocaleString("zh-CN");
  dom.maxMagnitude.textContent = magnitudes.length ? Math.max(...magnitudes).toFixed(1) : "—";
}

function setLayerVisibility(layerIds, visible) {
  layerIds.forEach((id) => {
    if (appState.map.getLayer(id)) appState.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  });
}

function bindControls() {
  const recencyToggleRow = dom.toggleRecent.closest(".switch-row");
  const recencyLabel = recencyToggleRow?.querySelector("span");
  const recencyText = [...(recencyLabel?.childNodes || [])].find((node) => node.nodeType === Node.TEXT_NODE);
  if (recencyText) recencyText.textContent = "近90天分段高亮";
  if (recencyToggleRow) recencyToggleRow.title = "橙色：0—30天；蓝色：31—60天；绿色：61—90天";
  dom.magnitudeRange.addEventListener("input", () => {
    appState.filters.magnitude = Number(dom.magnitudeRange.value);
    dom.magnitudeValue.textContent = appState.filters.magnitude.toFixed(1);
    updateSourcesAndStats();
  });
  dom.depthRange.addEventListener("input", () => {
    appState.filters.maxDepth = Number(dom.depthRange.value);
    dom.depthValue.textContent = `${appState.filters.maxDepth} km`;
    updateSourcesAndStats();
  });
  dom.yearSelect.addEventListener("change", () => { appState.filters.startYear = dom.yearSelect.value; updateSourcesAndStats(); });
  dom.basinSelect.addEventListener("change", () => { appState.filters.basin = dom.basinSelect.value; updateSourcesAndStats(); });
  dom.toggleDams.addEventListener("change", () => setLayerVisibility(["dam-halos", "dam-points"], dom.toggleDams.checked));
  dom.toggleQuakes.addEventListener("change", () => setLayerVisibility(["quake-clusters", "quake-cluster-count", "quake-points"], dom.toggleQuakes.checked));
  dom.toggleRecent.addEventListener("change", () => setLayerVisibility(["recent-halo", "previous-month-halo", "third-month-halo"], dom.toggleRecent.checked));
  dom.toggleWaterways.addEventListener("change", () => setLayerVisibility(["waterways-line"], dom.toggleWaterways.checked));
  dom.drawerClose.addEventListener("click", closeDrawer);
  document.addEventListener("pointerdown", (event) => {
    if (dom.detailDrawer.classList.contains("is-open") && !dom.detailDrawer.contains(event.target)) closeDrawer();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
  dom.mobileFilterButton.addEventListener("click", () => document.querySelector(".control-rail").classList.toggle("is-open"));
  dom.resetFilters.addEventListener("click", () => {
    Object.assign(appState.filters, { magnitude: 3, maxDepth: 100, startYear: "all", basin: "all" });
    dom.magnitudeRange.value = 3; dom.magnitudeValue.textContent = "3.0";
    dom.depthRange.value = 100; dom.depthValue.textContent = "100 km";
    dom.yearSelect.value = "all"; dom.basinSelect.value = "all";
    updateSourcesAndStats();
  });
}

function populateSelects() {
  const years = [...new Set(appState.earthquakes.features.map((feature) => new Date(feature.properties.time).getUTCFullYear()).filter(Number.isFinite))].sort((a, b) => b - a);
  years.forEach((year) => dom.yearSelect.add(new Option(`${year}年至今`, String(year))));
  const basins = [...new Set(appState.dams.features.map((feature) => feature.properties.basin).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  basins.forEach((basin) => dom.basinSelect.add(new Option(basin, basin)));
}

async function init() {
  try {
    [appState.dams, appState.earthquakes, appState.waterways, appState.waterLevels, appState.metadata] = await Promise.all([
      loadJson(DATA_PATHS.dams), loadJson(DATA_PATHS.earthquakes), loadJson(DATA_PATHS.waterways),
      loadJson(DATA_PATHS.waterLevels, { comparisonDays: 30, dams: {}, sources: {} }), loadJson(DATA_PATHS.metadata, {}),
    ]);
    populateSelects();
    bindControls();
    dom.lastUpdated.textContent = `更新于 ${formatDate(appState.metadata.updatedAt || appState.earthquakes.generatedAt, true)}`;

    appState.map = new maplibregl.Map({
      container: "map", style: rasterStyle(), center: [103.8, 29.2], zoom: 4.25,
      minZoom: 3, maxZoom: 13, attributionControl: false,
    });
    appState.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    appState.map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-right");
    appState.map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    appState.map.on("load", () => {
      addMapData();
      updateSourcesAndStats();
      dom.loadingScreen.classList.add("is-hidden");
    });
  } catch (error) {
    console.error(error);
    dom.loadingScreen.innerHTML = `<p>数据载入失败：${error.message}</p><p>请通过本地服务器或 GitHub Pages 打开本项目。</p>`;
  }
}

init();
