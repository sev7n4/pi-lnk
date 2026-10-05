#!/usr/bin/env python3
"""Production verify — U8 音频链路：提示词 TTS 边界上线 + run_audio_generation fail-loud。

对应 docs/superpowers/specs/2026-10-04-media-generation-audit.md U8：
  0. /api/agent/prompt-registry（免鉴）：gen_tool_policy 应为 1.2.0（含规则 23 TTS 边界），
     contentHash=90e08bce1596 —— 若仍是 1.1.0 ⇒ runtime 镜像未重发（runtime-deploy 手工派发）。
  1. /provider/bootstrap：用户渠道里有无可选 audio 模型（informational；U7 平台凭据未配时预期为空）。
  2. Turn 1：新建音频节点并要求生成 → 期望 upsert_media_node + propose_generation；
     同轮 run_audio_generation 若被尝试必须被 Gate 拦截（isError）。
  3. Turn 2：用户确认 → run_audio_generation：
     - 成功 ⇒ 产物必须是真实 URL（http/https），禁止 data: URL（U1 回归哨兵）；
       并有 canvas_action 落节点。
     - 失败 ⇒ 必须 isError 冒泡（fail-loud），且**不得**以「成功 + 占位内容」假绿
       （U1 之前的静默兜底形态）。平台 audio 凭据未配（U7 阻塞）时此分支为预期结果，
       脚本按 SKIP 级提示而非 FAIL，但冒泡本身必须发生。

Usage:
  python3 deploy/prod-audio-gen-verify.py
  BASE_URL=http://119.29.173.89:8888 PHONE=... CODE=... python3 deploy/prod-audio-gen-verify.py
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any
from urllib.request import Request, urlopen

BASE = os.environ.get("BASE_URL", "http://119.29.173.89:8888").rstrip("/")
API = f"{BASE}/api"
PHONE = os.environ.get("PHONE", "17279698608")
CODE = os.environ.get("CODE", "123456")
SSE_TIMEOUT_SEC = float(os.environ.get("SSE_TIMEOUT_SEC", "240"))

# U8① 定稿（prompt-registry/rules/gen_tool_policy.md v1.2.0）
EXPECTED_GEN_POLICY_VERSION = "1.2.0"
EXPECTED_GEN_POLICY_HASH = "90e08bce1596"

RUN_TOOLS = {
    "run_image_generation",
    "run_video_generation",
    "run_text_generation",
    "run_prompt_generation",
    "run_audio_generation",
}

PASS = FAIL = WARN = 0


def record(case: str, ok: bool, detail: str = "", *, warn_only: bool = False) -> None:
    global PASS, FAIL, WARN
    if ok:
        PASS += 1
        icon = "✅"
    elif warn_only:
        WARN += 1
        icon = "⚠️"
    else:
        FAIL += 1
        icon = "❌"
    line = f"{icon} {case}"
    if detail:
        line += f" — {detail[:240]}"
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
            "content": json.dumps(d.get("content", ""), ensure_ascii=False),
        }
    return out


def names(calls: list[dict]) -> set[str]:
    return {c["toolName"] for c in calls}


def check_registry() -> None:
    """U8① 上线核对：免鉴端点只出元信息（version/hash），不出正文。"""
    try:
        data = http("GET", "/agent/prompt-registry")
    except Exception as e:  # noqa: BLE001
        record("R0 prompt-registry diag reachable", False, f"{e}")
        return
    entries = data.get("entries") or (data.get("data") or {}).get("entries") or []
    gen = next((e for e in entries if e.get("id") == "gen_tool_policy"), None)
    if gen is None:
        record("R1 gen_tool_policy entry present", False, f"entries={len(entries)}")
        return
    ver = str(gen.get("version", ""))
    h = str(gen.get("contentHash", ""))
    record(
        f"R1 gen_tool_policy version == {EXPECTED_GEN_POLICY_VERSION}",
        ver == EXPECTED_GEN_POLICY_VERSION,
        f"actual={ver}",
        warn_only=True,
    )
    record(
        f"R2 gen_tool_policy contentHash == {EXPECTED_GEN_POLICY_HASH}",
        h == EXPECTED_GEN_POLICY_HASH,
        f"actual={h}",
        warn_only=True,
    )
    record("R3 registry not degraded", not bool(gen.get("degraded")), "", warn_only=True)


def check_audio_channel(tok: str) -> bool:
    """U7 前置探测：用户渠道是否配了 audio 模型。空 ⇒ Turn2 失败分支是预期。"""
    has_audio = False
    try:
        boot = http("GET", "/provider/bootstrap", t=tok)["data"]
        pref = boot.get("preferences") or {}
        sel = pref.get("selectableAudioModels") or []
        if isinstance(sel, str):
            sel = json.loads(sel)
        has_audio = len(sel) > 0
        chan_audio = []
        for ch in [boot.get("platformChannel") or {}, *(boot.get("channels") or [])]:
            for m in ch.get("models") or []:
                if isinstance(m, dict):
                    mname = str(m.get("name") or m.get("model") or "")
                    mcap = str(m.get("capability") or "")
                else:
                    mname, mcap = str(m), ""
                if "audio" in mcap or "tts" in mname.lower() or "speech" in mname.lower():
                    chan_audio.append(mname)
        record(
            "P1 user has selectable audio models",
            has_audio,
            f"selectable={len(sel)} channelAudio={sorted(set(chan_audio))[:5]}",
            warn_only=True,
        )
    except Exception as e:  # noqa: BLE001
        record("P1 provider/bootstrap probe", False, f"{e}", warn_only=True)
    return has_audio


def main() -> int:
    tag = uuid.uuid4().hex[:8]
    print(f"=== U8 audio gen verify (tag={tag}) ===\n")
    check_registry()
    print()

    try:
        http("POST", "/auth/send-code", {"phone": PHONE})
    except Exception:
        pass
    tok = http("POST", "/auth/login", {"phone": PHONE, "code": CODE})["data"]["token"]
    print("login ok")
    has_audio_channel = check_audio_channel(tok)
    sid = http("POST", "/sessions", {"title": f"u8-audio-{tag}"}, t=tok)["data"]["id"]
    tid = f"{sid}:{uuid.uuid4()}"
    print(f"session={sid}\n")

    # ── Turn 1: 建音频节点 + 要求生成 ──
    ev1, exit1 = sse_collect(
        tok,
        sid,
        f"（任务{tag}）新建一个音频节点，配音文案是「欢迎来到秋日上新专场」，然后帮我生成它的配音",
        tid,
    )
    c1, r1 = tool_calls(ev1), tool_results(ev1)
    n1 = names(c1)
    print(f"turn1 exit={exit1} tools={sorted(n1)}")
    record("T1 upsert_media_node called", "upsert_media_node" in n1)
    record("T1 propose_generation called", "propose_generation" in n1)
    run_attempted_1 = n1 & RUN_TOOLS
    if not run_attempted_1:
        record("T1 no run_* attempted (waited for confirm)", True, "gate/model held")
    else:
        blocked = all(r1[c["callId"]]["isError"] for c in c1 if c["toolName"] in RUN_TOOLS and c["callId"] in r1)
        record("T1 run_* (if attempted) blocked by gate", blocked, f"attempted={sorted(run_attempted_1)}")

    # ── Turn 2: 用户确认 → run_audio_generation ──
    ev2, exit2 = sse_collect(tok, sid, "确认生成", tid)
    c2, r2 = tool_calls(ev2), tool_results(ev2)
    n2 = names(c2)
    print(f"turn2 exit={exit2} tools={sorted(n2)}")
    record("T2 run_audio_generation called after confirm", "run_audio_generation" in n2)

    audio_calls = [c for c in c2 if c["toolName"] == "run_audio_generation" and c["callId"] in r2]
    if not audio_calls:
        record("T2 run_audio_generation result observed", False, "no tool_result for run_audio_generation")
        print(f"\n=== Summary PASS={PASS} FAIL={FAIL} WARN={WARN} ===")
        return 1

    ok_calls = [c for c in audio_calls if not r2[c["callId"]]["isError"]]
    err_calls = [c for c in audio_calls if r2[c["callId"]]["isError"]]

    if ok_calls:
        # 成功分支：产物必须是真实 URL，禁止 data: / 占位图（U1 哨兵）
        blob = " ".join(r2[c["callId"]]["content"] for c in ok_calls)
        record("T2 success has no data: URL (U1 sentinel)", "data:" not in blob.lower(), blob[:160])
        record(
            "T2 success has no placeholder image (U1 sentinel)",
            "unsplash" not in blob.lower() and "placehold" not in blob.lower(),
        )
        ca2 = [ev for ev in ev2 if ev.get("type") == "canvas_action"]
        record("T2 canvas_action derived", len(ca2) > 0, f"count={len(ca2)}")
    elif err_calls:
        # 失败分支：必须冒泡且给出下一步，不得虚构 url（fail-loud）
        blob = " ".join(r2[c["callId"]]["content"] for c in err_calls)
        record("T2 failure bubbles as isError (fail-loud)", True, blob[:160])
        record("T2 failure does not fabricate url", "http" not in blob.lower(), "no url in error")
        if has_audio_channel:
            record(
                "T2 upstream failed despite configured audio channel",
                False,
                "check channel creds / U7 platform TTS",
            )
        else:
            record(
                "T2 upstream failure expected (no audio channel configured — U7 blocker)",
                True,
                "",
                warn_only=True,
            )
    else:
        record("T2 run_audio_generation outcome classified", False, "neither ok nor error result")

    print(f"\n=== Summary PASS={PASS} FAIL={FAIL} WARN={WARN} ===")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
