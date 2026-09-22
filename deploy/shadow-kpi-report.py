#!/usr/bin/env python3
"""P0 shadow 验证 KPI 报告（spec §4.4.3 七项 KPI 的日志侧数据源）。

在 CVM 上运行：python3 deploy/shadow-kpi-report.py [--days 1] [--json]

数据来源：`docker logs lnkpi-api` 中 AgentService.pi 的 shadow 行：
  成功: ... [AgentService.pi] shadow <sessionId>: status=200 textLen=123 toolCalls=2 elapsed=4500ms
  失败: ... [AgentService.pi] shadow <sessionId> failed after 1200ms: <reason>

覆盖 KPI（日志可得部分；Prometheus 上线后迁移为指标采集）:
  K2 pi-runtime 5xx 率（status>=500 占比，QPS 未加权）
  K3 pi-runtime 延迟 p50/p95/p99（与 LangGraph p99 对比需另行采集）
  K7 RPC 通信成功率（shadow 镜像成功率近似）

K1/K4/K5/K6 需要自动化用例 / diff 工具 / 集群监控，另行落地。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from collections import Counter

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
SUCCESS_RE = re.compile(
    r"\[AgentService\.pi\] shadow (?P<sid>\S+): status=(?P<status>\w+) "
    r"textLen=(?P<textlen>\d+) toolCalls=(?P<tools>\d+) elapsed=(?P<elapsed>\d+)ms"
)
FAIL_RE = re.compile(
    r"\[AgentService\.pi\] shadow (?P<sid>\S+) failed after (?P<elapsed>\d+)ms: (?P<reason>.+)"
)
# Nest log 行前缀: "Nest] 09/23/2026, 03:55:01 AM ..."（容器本地时区，12 小时制）
TS_RE = re.compile(r"(?P<date>\d{2}/\d{2}/\d{4}), (?P<time>\d{1,2}:\d{2}:\d{2}) (?P<ampm>AM|PM)")


def parse_ts(line: str) -> dt.datetime | None:
    m = TS_RE.search(line)
    if not m:
        return None
    try:
        return dt.datetime.strptime(
            m["date"] + " " + m["time"] + " " + m["ampm"], "%m/%d/%Y %I:%M:%S %p"
        )
    except ValueError:
        return None


def percentile(sorted_vals: list[int], p: float) -> int:
    if not sorted_vals:
        return 0
    idx = min(len(sorted_vals) - 1, max(0, round(p / 100 * (len(sorted_vals) - 1))))
    return sorted_vals[idx]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=1.0, help="回看窗口（天），默认 1")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--container", default="lnkpi-api")
    args = ap.parse_args()

    raw = subprocess.run(
        ["docker", "logs", args.container], capture_output=True, text=True, errors="replace"
    )
    lines = (raw.stdout + raw.stderr).splitlines()
    cutoff = dt.datetime.now() - dt.timedelta(days=args.days)

    ok: list[dict] = []
    fail: list[dict] = []
    for raw_line in lines:
        if "AgentService.pi" not in raw_line:
            continue
        line = ANSI_RE.sub("", raw_line)
        ts = parse_ts(line)
        if ts is None or ts < cutoff:
            continue
        m = SUCCESS_RE.search(line)
        if m:
            status_word = m["status"]
            # B4 shadow 日志 status 为终态词：completed / failed / timeout 等
            if status_word == "completed":
                ok.append(
                    {
                        "ts": ts.isoformat(),
                        "session": m["sid"],
                        "status": status_word,
                        "textLen": int(m["textlen"]),
                        "toolCalls": int(m["tools"]),
                        "elapsedMs": int(m["elapsed"]),
                    }
                )
            else:
                fail.append(
                    {
                        "ts": ts.isoformat(),
                        "session": m["sid"],
                        "elapsedMs": int(m["elapsed"]),
                        "reason": f"status={status_word}",
                    }
                )
            continue
        m = FAIL_RE.search(line)
        if m:
            fail.append(
                {
                    "ts": ts.isoformat(),
                    "session": m["sid"],
                    "elapsedMs": int(m["elapsed"]),
                    "reason": m["reason"][:200],
                }
            )

    total = len(ok) + len(fail)
    statuses = Counter(o["status"] for o in ok)
    # 失败（异常/超时/断流/非 completed 终态）一律视为 RPC 级失败计入 5xx 等价物
    rpc_fail = len(fail)
    lat = sorted(o["elapsedMs"] for o in ok)
    report = {
        "window_days": args.days,
        "total_shadow_turns": total,
        "success": len(ok),
        "failed": len(fail),
        "k2_5xx_rate_pct": round(rpc_fail / total * 100, 3) if total else None,
        "k7_rpc_success_rate_pct": round(len(ok) / total * 100, 3) if total else None,
        "k3_latency_ms": {
            "p50": percentile(lat, 50),
            "p95": percentile(lat, 95),
            "p99": percentile(lat, 99),
            "max": lat[-1] if lat else 0,
        },
        "status_breakdown": dict(statuses),
        "top_fail_reasons": dict(Counter(f["reason"].split(":")[0][:80] for f in fail).most_common(5)),
        "tool_call_turns": sum(1 for o in ok if o["toolCalls"] > 0),
        "avg_text_len": round(sum(o["textLen"] for o in ok) / len(ok)) if ok else 0,
        "failures_tail": fail[-5:],
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print("== P0 Shadow KPI 报告 ==")
        print(f"窗口: {args.days} 天 | shadow 轮次: {total} (成功 {len(ok)} / 失败 {len(fail)})")
        if not total:
            print("窗口内无 shadow 流量 —— 确认 PI_RUNTIME_MODE=shadow 已生效且有真实 chat 流量")
            return 0
        print(f"K7 RPC 成功率: {report['k7_rpc_success_rate_pct']}% (阈值 K7=100%, 样本≥500)")
        print(f"K2 5xx 率: {report['k2_5xx_rate_pct']}% (阈值 <0.5%)")
        lat = report["k3_latency_ms"]
        print(f"K3 pi 延迟: p50={lat['p50']}ms p95={lat['p95']}ms p99={lat['p99']}ms max={lat['max']}ms (阈值 p99 ≤ LangGraph p99×1.5)")
        print(f"状态码分布: {report['status_breakdown']}")
        print(f"含工具调用轮次: {report['tool_call_turns']} | 平均 textLen: {report['avg_text_len']}")
        if fail:
            print(f"Top 失败原因: {report['top_fail_reasons']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
