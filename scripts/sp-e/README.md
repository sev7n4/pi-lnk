# SP-E 阶段 2 数据门 · 外部指标 scrape + 持久化

## 目的
服务端 `CanvasPatchMetrics` 是**进程内存单例**，每次部署清零，导致 14 天数据门无法跨部署累积
`stale_conflict` 等计数（决策门规格 §10 缺口 A）。本目录脚本在请求路径之外周期抓取
`GET /api/health/canvas-patch-metrics`，按 delta（带重置检测）把计数累加到本地持久化 JSON 存储。

> 零服务端代码改动：本目录在 `scripts/` 下，**不命中 `deploy.yml` 发布面**，不会触发生产部署。

## 运行（本机验证）
```bash
# 抓取一次并累积
python3 scripts/sp-e/scrape_canvas_metrics.py --once
# 查看窗口累计与门槛状态
python3 scripts/sp-e/scrape_canvas_metrics.py --report
```

## 部署到 CVM 周期运行（14 天窗口推荐）
SSH `deploy-cvm` 后，把脚本放到持久目录（如 `/opt/lnkpi-sp-e/`），`cron` 每 1–2 分钟跑一次：
```cron
*/2 * * * *  SP_E_STORE=/var/lib/lnkpi-sp-e/metrics-store.json /usr/bin/python3 /opt/lnkpi-sp-e/scrape_canvas_metrics.py --once >> /var/lib/lnkpi-sp-e/scrape.log 2>&1
```
⚠️ CVM `cron` 的 PATH 缺 `/usr/local/bin`；python3 用绝对路径。`/var/lib/lnkpi-sp-e/` 须先建且持久
（非 `/tmp`，避免重启丢失）。存储文件路径经 `SP_E_STORE` 或 `--store` 指定。

## day-0 启动窗口
在确认阶段 2 服务端埋点（缺口 B：raw 事件）已上线并验证后：
```bash
python3 scripts/sp-e/scrape_canvas_metrics.py --once        # 先建立基线
python3 scripts/sp-e/scrape_canvas_metrics.py --init-window # 设定 day-0
```
窗口内计数 = 当前累积 − 窗口基线。`--report` 打印 G1 主计数（staleConflict ≥ 30）。

## 状态
- [x] 缺口 A：外部 scrape + 跨部署累积（本脚本）
- [x] 缺口 B：服务端 `recentConflicts` 环形缓冲 + `sessionsWithStaleConflict`（已并入阶段2 PR）；
      本脚本持久化 raw 事件并补 G1「≥3 session」与 G3 409 率上界估算
- [ ] 缺口 D：G1「≥30」阈值校准（基于采样窗）
- [ ] 缺口 C：day-0 启动 + 14 天后判门
