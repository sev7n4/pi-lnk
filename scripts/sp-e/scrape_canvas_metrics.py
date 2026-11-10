#!/usr/bin/env python3
"""SP-E 阶段 2 数据门 — 外部指标 scrape + 跨部署持久化累积。

解决的问题（决策门规格 §10 / daily log 缺口 A）：
  服务端 CanvasPatchMetrics 是进程内存单例，每次部署清零，
  14 天数据门无法跨部署累积 stale_conflict 等计数 ⇒ 本脚本在请求路径之外
  周期抓取 /api/health/canvas-patch-metrics，按 delta（带重置检测）把计数
  累加到本地持久化 JSON 存储，从而给出 14 天窗口的累计值。

设计要点：
  - 零服务端代码改动（不命中 deploy.yml 发布面，本文件在 scripts/ 下）。
  - 增量 = max(0, 当前 - 上次)；若 当前 < 上次 ⇒ 判定部署重置，增量按当前值计
    （仅损失两次抓取之间的少量增量，冲突极稀有，可接受）。
  - 累积只在成功抓取后写入；存储文件即真相源，可随脚本重启恢复。
  - window_start / window_baseline 显式由 --init-window 设定（day-0），
    窗口内计数 = 当前累积 - 窗口基线。
  - 将来阶段 2 服务端补 raw 事件后，脚本自动多抓 conflictEventsTotal /
    recentConflicts / sessionsWithStaleConflict（COUNTER_FIELDS 追加即可）。

用法：
  python3 scrape_canvas_metrics.py --once            # 抓取一次并累积
  python3 scrape_canvas_metrics.py --init-window     # 设定 day-0（先 --once 一次）
  python3 scrape_canvas_metrics.py --report          # 打印窗口累计与门槛状态
  python3 scrape_canvas_metrics.py --reset-store     # 清空存储（慎用）
  --url <base>   默认 http://119.29.173.89:8888
  --store <path> 默认 $SP_E_STORE 或脚本同目录 metrics-store.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

STORE_VERSION = 1

# 需要跨部署累加的单调计数器字段（服务端 snapshot() 的 metrics 内）。
# 阶段 2 服务端补 raw 事件后追加：conflictEventsTotal / sessionsWithStaleConflict。
COUNTER_FIELDS = [
    "patches",
    "ops",
    "applied",
    "skipped",
    "nearConcurrentPairs",
    "keyOverlapPairs",
    "staleConflict",
]

DEFAULT_URL = "http://119.29.173.89:8888"
ENDPOINT = "/api/health/canvas-patch-metrics"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _zero_cumulative() -> dict:
    return {f: 0 for f in COUNTER_FIELDS} | {
        "scrapes": 0,
        "resets_detected": 0,
        "lost_to_reset": 0,
    }


def _empty_store(url: str) -> dict:
    return {
        "version": STORE_VERSION,
        "prod_base_url": url,
        "window_start": None,
        "window_start_set_at": None,
        "window_baseline": None,
        "last_seen": None,
        "cumulative": _zero_cumulative(),
        "latest": {"ts": None, "distinctClients": 0, "metrics": None},
        # 缺口 B：持久化 raw 冲突事件（跨部署累积，用于 distinct session 与 G3 回放）
        "conflictEvents": {},
        "history": [],
    }


def load_store(path: str, url: str) -> dict:
    if not os.path.exists(path):
        return _empty_store(url)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("version") != STORE_VERSION:
            sys.stderr.write(f"[warn] store version mismatch ({data.get('version')}), reinit\n")
            return _empty_store(url)
        return data
    except (json.JSONDecodeError, OSError) as exc:
        sys.stderr.write(f"[warn] store unreadable ({exc}), reinit\n")
        return _empty_store(url)


def save_store(path: str, data: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def fetch_metrics(base_url: str, timeout: int = 15) -> dict:
    url = f"{base_url.rstrip('/')}{ENDPOINT}"
    req = urllib.request.Request(url, headers={"User-Agent": "sp-e-metrics-scraper/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"endpoint not ok: {payload}")
    return payload


def _metrics_counters(metrics: dict) -> dict:
    return {f: int(metrics.get(f, 0)) for f in COUNTER_FIELDS}


def accumulate(store: dict, metrics: dict, scrape_ts: str) -> dict:
    """返回 (delta, reset_detected)，就地更新累积值。"""
    cur = _metrics_counters(metrics)
    last = store.get("last_seen")
    cum = store["cumulative"]

    reset_detected = False
    if last is not None:
        for f in COUNTER_FIELDS:
            if cur[f] < last.get(f, 0):
                reset_detected = True
                break

    if reset_detected:
        # 部署重置：增量按当前值计（丢失上次抓取→重置之间的少量增量）
        for f in COUNTER_FIELDS:
            cum[f] += cur[f]
        cum["resets_detected"] += 1
        # 估算丢失量（上次的累计增量中未捕获部分，仅作为可见性标注）
        lost = sum(max(0, last.get(f, 0) - 0) for f in COUNTER_FIELDS)
        cum["lost_to_reset"] += lost
    else:
        for f in COUNTER_FIELDS:
            delta = cur[f] - (last.get(f, 0) if last else 0)
            cum[f] += max(0, delta)

    cum["scrapes"] += 1
    store["last_seen"] = cur
    # 缺口 B：合并 raw 冲突事件（按稳定键去重，避免环形缓冲重复返回）
    recent = metrics.get("recentConflicts") or []
    for ev in recent:
        key = f"{ev.get('sessionId')}|{ev.get('clientA')}|{ev.get('clientB')}|{ev.get('ts')}|{','.join(ev.get('keys') or [])}"
        store["conflictEvents"].setdefault(key, ev)
    store["latest"] = {
        "ts": scrape_ts,
        "distinctClients": int(metrics.get("distinctClients", 0)),
        "sessionsWithStaleConflict": int(metrics.get("sessionsWithStaleConflict", 0)),
        "metrics": metrics,
    }
    # 历史上限保留 500 条，防止无限增长
    hist = store.setdefault("history", [])
    hist.append({"ts": scrape_ts, "counters": cur, "reset": reset_detected})
    if len(hist) > 500:
        del hist[: len(hist) - 500]
    return cur, reset_detected


def cmd_once(args) -> int:
    store = load_store(args.store, args.url)
    store["prod_base_url"] = args.url
    try:
        payload = fetch_metrics(args.url)
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, ValueError, OSError) as exc:
        sys.stderr.write(f"[error] fetch failed: {exc}\n")
        return 2
    ts = payload.get("timestamp") or _now_iso()
    metrics = payload.get("metrics", {})
    _, reset = accumulate(store, metrics, ts)
    save_store(args.store, store)
    print(f"[ok] scraped @ {ts}  reset_detected={reset}")
    print(f"     cumulative={json.dumps(store['cumulative'], ensure_ascii=False)}")
    print(f"     latest distinctClients={store['latest']['distinctClients']}")
    return 0


def cmd_init_window(args) -> int:
    store = load_store(args.store, args.url)
    if store["last_seen"] is None:
        sys.stderr.write("[warn] no baseline yet; run --once at least once first\n")
        return 2
    store["window_start"] = _now_iso()
    store["window_start_set_at"] = _now_iso()
    store["window_baseline"] = dict(store["cumulative"])  # 复制当前累积作为窗口基线
    save_store(args.store, store)
    print(f"[ok] day-0 window started @ {store['window_start']}")
    print(f"     baseline={json.dumps(store['window_baseline'], ensure_ascii=False)}")
    return 0


def cmd_report(args) -> int:
    store = load_store(args.store, args.url)
    cum = store["cumulative"]
    base = store.get("window_baseline") or _zero_cumulative()
    window = {f: cum[f] - base.get(f, 0) for f in COUNTER_FIELDS}
    # 缺口 B：distinct 冲突 session（跨部署累积，取持久化 raw 事件的去重 session 集合）
    conflict_sessions = {ev.get("sessionId") for ev in store.get("conflictEvents", {}).values() if ev.get("sessionId")}
    window_conflict_events = len(store.get("conflictEvents", {}))
    g1_count = window["staleConflict"]
    # 缺口 B / G3：409 率上界（保守假设所有 stale_conflict 在 CAS 下均变 409）
    g3_upper = (window_conflict_events / window["patches"]) if window["patches"] else 0.0
    print("=== SP-E 阶段 2 数据门 · 14 天窗口累计（缺口 A 外部累积 + 缺口 B raw 事件）===")
    print(f"prod_base_url     : {store['prod_base_url']}")
    print(f"window_start      : {store['window_start']} (day-0)")
    print(f"last_scrape_ts    : {store['latest']['ts']}")
    print(f"scrapes / resets  : {cum['scrapes']} / {cum['resets_detected']}")
    print(f"lost_to_reset     : {cum['lost_to_reset']} (估算，冲突极稀有可忽略)")
    print("--- 窗口内计数 ---")
    for f in COUNTER_FIELDS:
        print(f"  {f:22s}: {window[f]}")
    print(f"  distinctClients (latest snapshot): {store['latest'].get('distinctClients')}")
    print("--- 门槛 ---")
    print(f"  G1 staleConflict >= 30 ? {g1_count} >= 30 -> {'MET' if g1_count >= 30 else 'NOT MET (当前)'}")
    print(f"  G1 session >= 3      ? {len(conflict_sessions)} distinct (raw 事件去重) -> {'MET' if len(conflict_sessions) >= 3 else 'NOT MET (当前)'}")
    print(f"  G3 409率上界        ? {g3_upper:.4%} (冲突事件 {window_conflict_events} / patches {window['patches']}) < 0.5% -> {'MET' if g3_upper < 0.005 else 'NOT MET'}")
    print("  G2 用户可感知丢失    ? 外部证据门（客诉/事故/刻意复现），须人工收集，不能自动判定")
    return 0


def cmd_reset_store(args) -> int:
    store = _empty_store(args.url)
    save_store(args.store, store)
    print(f"[ok] store reset -> {args.store}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="SP-E canvas metrics external scraper")
    ap.add_argument("--url", default=DEFAULT_URL, help="prod base url (default %(default)s)")
    ap.add_argument(
        "--store",
        default=os.environ.get("SP_E_STORE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "metrics-store.json")),
        help="persistent store path",
    )
    grp = ap.add_mutually_exclusive_group(required=True)
    grp.add_argument("--once", action="store_true", help="fetch once and accumulate")
    grp.add_argument("--init-window", action="store_true", help="set day-0 window start")
    grp.add_argument("--report", action="store_true", help="print window cumulative + gate status")
    grp.add_argument("--reset-store", action="store_true", help="wipe store")
    args = ap.parse_args()

    if args.once:
        return cmd_once(args)
    if args.init_window:
        return cmd_init_window(args)
    if args.report:
        return cmd_report(args)
    if args.reset_store:
        return cmd_reset_store(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
