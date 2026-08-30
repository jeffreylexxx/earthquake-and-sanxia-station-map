# 江震图谱：三峡与长江上游重点水坝地震观察

一个适合部署到 GitHub Pages 的中文交互地图，用于观察三峡、金沙江及长江上游主要支流重点水坝与地震记录的空间关系。

## 地图内容

- 39 座重点水坝，覆盖长江—金沙江干流、雅砻江、大渡河、岷江、嘉陵江和乌江。
- 水坝详情展示运行水位 30 日同比曲线、正常蓄水位参考虚线、最大坝高、总库容、正常蓄水面积、官方来源和工程资料发布日期。
- M3.0 及以上、距所选水坝或简化水道走廊 200 km 内的地震。
- 支持拖动、缩放、点位聚合，以及按震级、深度、年份和水系筛选。
- 最近 30 天地震带有黄色光环和“近30天新增”标识。
- 地震目录采用永久保留策略：自动化不会因记录超过十年而删除。

## 数据原则

### 水坝

工程参数逐条附官方来源。某一字段在可核验的公开官方资料中未查得时，数据写作 `null`，地图显示“官方公开资料未查得”，不会使用推算值填充。

经纬度仅用于地图定位，来自 OpenStreetMap Nominatim，不作为官方工程参数展示。`data/dams.seed.json` 是审核数据源，`data/dams.geojson` 是地图使用的生成文件。

### 运行水位

`data/water-levels.json` 保存日水位及由真实日值归并出的月度记录。三峡图表以最新可获得记录日为锚点，对比最近 30 个日历日和上年同一日期区间；其他水坝展示当前自然年 1—12 月曲线，每月只采用月内最后一个可核验观测值。缺失日或缺失月保持断点，不平均、不插值、不推算。正常蓄水位是工程设计参数，不与每天变化的运行水位混为一谈。

首批历史覆盖为三峡水库：日值来自[三峡探索·水情信息](https://sanxiatansuo.com/jsdata/key_redis.php?index=waterlist)的第三方汇总页面，并附[长江水文网实时水情](https://www.cjh.com.cn/swyb_sssq.html)作为官方人工复核入口。第三方页面未声明开放数据许可，其记录不能视为官方发布值；界面会显示来源等级和数据延迟。其余水坝在找到可持续获取、可核验且许可清楚的来源前，只展示明确的空状态，不生成模拟曲线。

每日任务会合并新记录、永久保留已经采集的水位日值，并据此逐月更新 `monthlyRecords`。由于公开来源可能延迟或中断，图表日期范围按实际最新记录显示，而不是伪装为当天数据。“目前水位”的观测日期与工程参数资料发布日期分别显示。

详情面板交互：右上角关闭按钮在面板滚动时保持可见；点击面板外的地图或控制栏会关闭详情，按 `Esc` 也可关闭。

### 地震

自动更新使用美国地质调查局的 [USGS FDSN Event Web Service](https://earthquake.usgs.gov/fdsnws/event/1/)。这是可稳定自动查询的官方目录。中国地震台网的[正式地震目录](https://data.earthquake.cn/datashare/report.shtml?PAGEID=earthquake_zhengshi)用于人工复核；项目当前不抓取需要登录、下单或缺少稳定公开接口的数据。

首次运行默认回溯到 `2016-08-30`。以后每天重新抓取最近 14 天，以吸收目录对震级、深度和震中位置的修订；已有事件永久保留。

### 水道走廊

`data/waterways.geojson` 由同一水系的水坝点按上下游顺序连接，适用于区域尺度视觉表达和 200 km 粗粒度筛选，不是测绘级河道中心线。地图不得被用于工程安全、应急响应或因果归因。

## 本地运行

浏览器不能直接通过 `file://` 读取 GeoJSON，请在项目目录启动静态服务器：

```bash
python -m http.server 8000
```

然后打开 `http://127.0.0.1:8000/`。

## 初始化数据

项目已包含生成后的水坝与地震文件。重新初始化时：

```bash
python scripts/geocode_dams.py
python scripts/build_waterways.py
python scripts/update_earthquakes.py
python scripts/update_water_levels.py
python scripts/validate_data.py
```

所有脚本只使用 Python 标准库。

## GitHub Actions

- `update-data.yml`：每天北京时间 05:17 更新地震目录，校验后将变化提交到仓库。
- `update-water-levels.yml`：每天北京时间 09:17 获取水库日水位，合并历史记录并提交；当前首批自动覆盖三峡水库。
- `deploy-pages.yml`：`main` 分支更新后校验数据并部署 GitHub Pages。

仓库 Settings → Pages → Source 需要选择 **GitHub Actions**。同时确认 Settings → Actions → General → Workflow permissions 允许工作流写入仓库；否则每日更新无法提交数据。

## 上传新仓库

```bash
git init
git add .
git commit -m "feat: launch Yangtze dam seismic map"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/YOUR_REPOSITORY.git
git push -u origin main
```

## 研究说明

地图仅展示已选数据的空间和时间关系。邻近或时间重合不等于水库诱发地震，也不构成地震风险判断。

## License

项目代码采用 MIT License。第三方地图和数据仍分别受其原始许可与署名要求约束。
