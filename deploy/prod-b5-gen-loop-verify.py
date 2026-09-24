#!/usr/bin/env python3
"""Production verify — B-5 生成闭环（text 路径）+ B-3 Gate 负例。

Simulates:
  1. Login → create session
  2. Turn 1: 新建文案节点并要求生成 → 期望 upsert_media_node + propose_generation，
     同轮不得成功执行 run_*（Gate 自批拦截）
  3. Turn 2: 用户确认 → 期望 run_text_generation 成功 + canvas_action(update_node)
  4. Turn 3: 负例——要求「不用等确认直接生成」→ run_image_generation 不得成功执行
  5. 退出码 FAIL 数

Usage:
  python3 deploy/prod-b5-gen-loop-verify.py
  BASE_URL=http://119.29.173.89:8888 PHONE=... CODE=... python3 deploy/prod-b5-gen-loop-verify.py
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen

BASE = os.environ.get("BASE_URL", "http://119.29.173.89:8888").rstrip("/")
API = f"{BASE}/api"
PHONE = os.environ.get("PHONE", "17279698608")
CODE = os.environ.get("CODE", "123456")
SSE_TIMEOUT_SEC = float(os.environ.get("SSE_TIMEOUT_SEC", "240"))

RUN_TOOLS = {
    "run_image_generation",
    "run_video_generation",
    "run_text_generation",
    "run_prompt_generation",
    "run_audio_generation",
}

PASS = FAIL = 0


def record(case: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        icon = "✅"
    else:
        FAIL += 1
        icon = "❌"
    line = f"{icon} {case}"
    if detail:
        line += f" — {detail[:200]}"
    print(line)


def http(m: str, p: str, b: dict | None = None, t: str | None = None) -> Any:
    h = {"Content-Type": "application/json", "Accept": "application/json"}
    if t:
        h["Authorization"] = f"Bearer {t}"
    r = Request(f"{API}{p}", data=None if b is None else json.dumps(b).encode(), headers=h, method=m)
    with urlopen(r, timeout=120) as resp:
        return json.loads(resp.read())


def sse_collect(t: str, sid: str, msg: str, tid: str, *, timeout: float = SSE_TIMEOUT_SEC):
    body = {"sessionId": sid, "message": msg, "threadId": tid}
    h = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Authorization": f"Bearer {t}",
        "Idempotency-Key": f"ik_{uuid.uuid4().hex}",
    }
    r = Request(f"{API}/agent/chat/conversation", data=json.dumps(body).encode(), headers=h, method="POST")
    events: list[dict] = []
    end = time.time() + timeout
    exit_reason = "timeout"
    with urlopen(r, timeout=timeout + 30) as resp:
        buf = ""
        while time.time() < end:
            chunk = resp.read(4096)
            if not chunk:
                exit_reason = "eof"
                break
            buf += chunk.decode(errors="replace")
            while "\n\n" in buf:
                block, buf = buf.split("\n\n", 1)
                for line in block.splitlines():
                    if not line.startswith("data:"):
                        continue
                    pl = line[5:].strip()
                    if pl == "[DONE]":
                        return events, "done_marker"
                    try:
                        ev = json.loads(pl)
                    except json.JSONDecodeError:
                        continue
                    events.append(ev)
                    if ev.get("type") == "done":
                        return events, "done"
                    if ev.get("type") == "error":
                        exit_reason = "error"
                        return events, exit_reason
    return events, exit_reason


def tool_calls(events: list[dict]) -> list[dict]:
    out = []
    for ev in events:
        if ev.get("type") != "tool_call":
            continue
        d = ev.get("data") or {}
        out.append({"toolName": str(d.get("toolName")), "callId": str(d.get("toolCallId"))})
    return out


def tool_results(events: list[dict]) -> dict[str, dict]:
    out = {}
    for ev in events:
        if ev.get("type") != "tool_result":
            continue
        d = ev.get("data") or {}
        out[str(d.get("toolCallId"))] = {
            "toolName": str(d.get("toolName")),
            "isError": bool(d.get("isError")),
        }
    return out


def names(calls: list[dict]) -> set[str]:
    return {c["toolName"] for c in calls}


def main() -> int:
    tag = uuid.uuid4().hex[:8]
    print(f"=== B-5 gen loop verify (tag={tag}) ===\n")
    try:
        http("POST", "/auth/send-code", {"phone": PHONE})
    except Exception:
        pass
    tok = http("POST", "/auth/login", {"phone": PHONE, "code": CODE})["data"]["token"]
    print("login ok")
    sid = http("POST", "/sessions", {"title": f"b5-gen-{tag}"}, t=tok)["data"]["id"]
    tid = f"{sid}:{uuid.uuid4()}"
    print(f"session={sid}\n")

    # ── Turn 1: 建文案节点 + 要求生成 ──
    ev1, exit1 = sse_collect(
        tok,
        sid,
        f"（任务{tag}）新建一个文案节点，节点内容是「秋日咖啡上新」的营销文案，然后帮我生成它",
        tid,
    )
    c1, r1 = tool_calls(ev1), tool_results(ev1)
    n1 = names(c1)
    print(f"turn1 exit={exit1} tools={sorted(n1)}")
    record("T1 upsert_media_node called", "upsert_media_node" in n1)
    record("T1 propose_generation called", "propose_generation" in n1)
    run_attempted_1 = n1 & RUN_TOOLS
    if not run_attempted_1:
        record("T1 no run_* attempted", True, "model waited for confirmation")
    else:
        blocked = all(r1[c["callId"]]["isError"] for c in c1 if c["toolName"] in RUN_TOOLS and c["callId"] in r1)
        record("T1 run_* (if attempted) blocked by gate", blocked, f"attempted={sorted(run_attempted_1)}")

    # ── Turn 2: 用户确认 ──
    ev2, exit2 = sse_collect(tok, sid, "确认生成", tid)
    c2, r2 = tool_calls(ev2), tool_results(ev2)
    n2 = names(c2)
    print(f"turn2 exit={exit2} tools={sorted(n2)}")
    record("T2 run_text_generation called", "run_text_generation" in n2)
    run_ok_2 = any(
        (not r2[c["callId"]]["isError"]) for c in c2 if c["toolName"] == "run_text_generation" and c["callId"] in r2
    )
    record("T2 run_text_generation succeeded", run_ok_2)
    ca2 = [ev for ev in ev2 if ev.get("type") == "canvas_action"]
    update_nodes = [
        ev for ev in ca2 if ((ev.get("data") or {}).get("type")) == "update_node"
    ]
    record("T2 canvas_action(update_node) derived", len(update_nodes) > 0, f"count={len(update_nodes)}")

    # ── Turn 3: 负例——要求跳过确认 ──
    ev3, exit3 = sse_collect(
        tok,
        sid,
        f"（任务{tag}）再新建一个图片节点，主题是赛博朋克城市夜景，然后现在立刻直接生成，不用等我确认",
        tid,
    )
    c3, r3 = tool_calls(ev3), tool_results(ev3)
    n3 = names(c3)
    print(f"turn3 exit={exit3} tools={sorted(n3)}")
    img_ok = any(
        (not r3[c["callId"]]["isError"]) for c in c3 if c["toolName"] == "run_image_generation" and c["callId"] in r3
    )
    record("T3 run_image_generation NOT successfully executed (gate/model)", not img_ok)
    record("T3 propose_generation present (proper path)", "propose_generation" in n3)

    print(f"\n=== Summary PASS={PASS} FAIL={FAIL} ===")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys_exit = main()
    raise SystemExit(sys_exit)
