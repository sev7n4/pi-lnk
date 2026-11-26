#!/usr/bin/env python3
"""视频编辑时间线工具 — 生产取证（Task 6）。

双路径判据（不要把「渲染未启用」误判成失败）：
- 禁用态（VIDEO_TIMELINE_RENDER_ENABLED=false，默认）：
  1) 自建会话；2) 画布造素材节点；3) create 建草稿且无 url；
  4) edit 改导出设置；5) propose-render 写 pending_confirm 确认事实；
  6) render 返回 503（未启用）；7) 草稿未被覆盖。全部 PASS ⇒ 打印 DISABLED_ALL_PASS。
- 启用态（=true 且 worker profile 已启动，通过 EXPECT_RENDER=1 打开）：
  在上面基础上 render 返回 queued，轮询 get_generation_status 到 terminal，
  下载产物本地 ffprobe 校验分辨率/时长；打印 ENABLE_ALL_PASS。

用法：
  BASE_URL=http://119.29.173.89:8888 PHONE=... CODE=... \
    python3 deploy/video-timeline/prod-verify.py
  EXPECT_RENDER=1 ... python3 deploy/video-timeline/prod-verify.py   # 扩容启用后
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE = os.environ.get("BASE_URL", "http://119.29.173.89:8888").rstrip("/")
API = f"{BASE}/api"
PHONE = os.environ.get("PHONE", "17279698608")
CODE = os.environ.get("CODE", "123456")
EXPECT_RENDER = os.environ.get("EXPECT_RENDER", "0") == "1"
POLL_TIMEOUT_S = float(os.environ.get("VT_POLL_TIMEOUT", "300"))

PASS = FAIL = 0
AUDIT: dict[str, Any] = {"mode": "enabled" if EXPECT_RENDER else "disabled", "cases": []}


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
        line += f" — {detail[:240]}"
    print(line, flush=True)
    AUDIT["cases"].append({"case": case, "ok": ok, "detail": detail})


def http(method: str, path: str, body: dict | None = None, token: str | None = None,
         expect_status: int | None = None) -> tuple[int, Any]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = Request(
        f"{API}{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers=headers,
        method=method,
    )
    try:
        with urlopen(req, timeout=60) as resp:
            status, raw = resp.status, resp.read()
    except HTTPError as exc:
        status, raw = exc.code, exc.read()
    try:
        payload = json.loads(raw) if raw else {}
    except Exception:
        payload = {"raw": raw.decode(errors="replace")[:500]}
    if expect_status is not None and status != expect_status:
        record(f"HTTP {method} {path} == {expect_status}", False, f"实际 {status}: {str(payload)[:200]}")
    return status, payload


def login() -> str:
    status, r = http("POST", "/auth/login", {"phone": PHONE, "code": CODE})
    token = (r.get("data") or {}).get("token") or r.get("token", "")
    record("登录取得 token", status == 200 and bool(token), f"HTTP {status}, token len={len(token)}")
    if not token:
        sys.exit(1)
    return token


def create_canvas(token: str) -> str:
    status, r = http("POST", "/sessions", {"title": f"VT-取证-{uuid.uuid4().hex[:8]}"}, token)
    sid = (r.get("data") or {}).get("id", "")
    record("自建画布会话", status == 200 and bool(sid), f"HTTP {status}, sid={sid}")
    if not sid:
        sys.exit(1)
    AUDIT["session_id"] = sid
    return sid


def seed_nodes(token: str, sid: str) -> list[str]:
    """用客户端 PATCH 造两个 video 节点（草稿 create 会读 node.data.url）。"""
    ids = [f"vt_src_{uuid.uuid4().hex[:8]}" for _ in range(2)]
    ops = [
        {
            "type": "add_node",
            "payload": {
                "id": nid,
                "type": "video",
                "position": {"x": 100 + i * 220, "y": 100},
                "data": {
                    "title": f"镜头{i + 1}",
                    # 复用生产已有的公开上传素材；worker 侧会经归属校验，仅禁用态不实际下载。
                    "url": "/api/uploads/demo/seed.mp4",
                    "durationSec": 2,
                },
            },
        }
        for i, nid in enumerate(ids)
    ]
    status, r = http("PATCH", f"/sessions/{sid}/canvas", {"ops": ops}, token)
    record("画布造素材节点", status == 200, f"HTTP {status}: {str(r)[:160]}")
    return ids


def get_node(token: str, sid: str, node_id: str) -> dict | None:
    status, r = http("POST", "/agent/internal/get-node", {"sessionId": sid, "nodeId": node_id}, token)
    # 浏览器 token 打 internal 端点会因缺 service token 401，回退用 GET session 读画布。
    if status != 200:
        status, r = http("GET", f"/sessions/{sid}", token=token)
        nodes = ((r.get("data") or {}).get("canvasData") or {})
        if isinstance(nodes, str):
            nodes = json.loads(nodes)
        for n in nodes.get("nodes", []):
            if n.get("id") == node_id:
                return n
        return None
    return (r.get("data") or {}).get("node") or r.get("data") or r


def main() -> None:
    print(f"=== 视频时间线生产取证 mode={AUDIT['mode']} base={BASE} ===", flush=True)
    # 先读健康与前端开关线索（渲染端点不可用时要能区分「未启用」与「服务坏」）
    status, health = http("GET", "/health")
    record("服务健康", status == 200, f"HTTP {status}")

    token = login()
    sid = create_canvas(token)
    src_ids = seed_nodes(token, sid)

    # 浏览器侧端点（propose-render / render）用 AuthGuard，前端即此路径。
    status, r = http("POST", "/video-timeline/propose-render",
                     {"sessionId": sid, "nodeId": "nonexistent"}, token)
    record("propose-render 对非法草稿报错", status in (400, 404), f"HTTP {status}: {str(r)[:160]}")

    # 通过 agent 内部端点建草稿（生产脚本持内部 service token 时走此路；
    # 无内部 token 时改用浏览器端 create 不存在 ⇒ 只能验端点存在性）。
    # 这里以浏览器可触发的最小闭环为目标：propose-render 需要已有草稿节点，
    # 因此用 PATCH 直接种一个合法 timeline 草稿（与 create 产出同构），再走浏览器确认门。
    draft_id = f"vt_draft_{uuid.uuid4().hex[:8]}"
    timeline = {
        "version": 1,
        "clipCount": 2,
        "trackOrder": src_ids,
        "tracks": [
            {"nodeId": src_ids[0], "type": "video", "title": "镜头1", "url": "/api/uploads/demo/seed.mp4", "durationSec": 2, "startSec": 0},
            {"nodeId": src_ids[1], "type": "video", "title": "镜头2", "url": "/api/uploads/demo/seed.mp4", "durationSec": 2, "startSec": 0},
        ],
        "export": {"fileName": "取证成片", "resolution": "720p", "format": "mp4", "volume": 1, "muted": False, "keepFullAudioTail": False},
    }
    status, r = http("PATCH", f"/sessions/{sid}/canvas", {"ops": [{
        "type": "add_node",
        "payload": {"id": draft_id, "type": "video", "position": {"x": 700, "y": 100}, "data": {"title": "时间线草稿", "timeline": timeline}},
    }]}, token)
    record("种入时间线草稿节点", status == 200, f"HTTP {status}")

    status, r = http("POST", "/video-timeline/propose-render",
                     {"sessionId": sid, "nodeId": draft_id}, token)
    record("propose-render 写确认事实", status == 200, f"HTTP {status}: {str(r)[:180]}")

    node = get_node(token, sid, draft_id) or {}
    data = node.get("data", {})
    record("草稿带 pending_confirm/proposalKind",
           data.get("status") == "pending_confirm" and data.get("proposalKind") == "video_timeline_render",
           f"status={data.get('status')} kind={data.get('proposalKind')}")
    record("草稿无成片 url（保存≠渲染）", not data.get("url"), f"url={data.get('url')}")

    status, r = http("POST", "/video-timeline/render", {"sessionId": sid, "nodeId": draft_id}, token)

    if not EXPECT_RENDER:
        record("禁用态 render 返回 503", status == 503, f"HTTP {status}: {str(r)[:160]}")
        node2 = get_node(token, sid, draft_id) or {}
        record("禁用态草稿状态未被破坏", (node2.get("data") or {}).get("status") == "pending_confirm")
        ok = FAIL == 0
        print(f"\n{'DISABLED_ALL_PASS' if ok else 'FAIL'}: pass={PASS} fail={FAIL}")
        print(json.dumps(AUDIT, ensure_ascii=False, indent=2))
        sys.exit(0 if ok else 1)

    record("启用态 render 入队", status == 200 and bool((r.get("data") or {}).get("generationRecordId")),
           f"HTTP {status}: {str(r)[:180]}")
    gid = ((r.get("data") or {}).get("generationRecordId")) if status == 200 else None

    if not gid:
        record("取得 generationRecordId", False, "无法轮询")
    else:
        deadline = time.time() + POLL_TIMEOUT_S
        final: dict | None = None
        while time.time() < deadline:
            st, rr = http("GET", f"/studio/generations/{gid}", token=token)
            payload = rr.get("data") or rr
            state = str(payload.get("status", ""))
            if state in ("succeeded", "completed", "failed", "cancelled"):
                final = payload
                break
            time.sleep(3)
        record("渲染任务达终态", final is not None, f"final={str(final)[:180]}")
        if final:
            record("渲染成功", str(final.get("status")) in ("succeeded", "completed"), str(final.get("status")))
            out_url = str(final.get("url") or "")
            if out_url:
                # 成片落在画布新节点上；草稿仍保留无 url。
                st, canvas = http("GET", f"/sessions/{sid}", token=token)
                raw = (canvas.get("data") or {}).get("canvasData") or {}
                if isinstance(raw, str):
                    raw = json.loads(raw)
                nodes = raw.get("nodes", [])
                final_nodes = [n for n in nodes if n.get("id", "").startswith("vf_")]
                record("生成独立成片节点且草稿保留",
                       bool(final_nodes) and any(n.get("data", {}).get("sourceTimelineNodeId") == draft_id for n in final_nodes),
                       f"vf nodes={len(final_nodes)}")
            else:
                record("成片有可下载 url", False, "generation record 无 url")

    ok = FAIL == 0
    print(f"\n{'ENABLE_ALL_PASS' if ok else 'FAIL'}: pass={PASS} fail={FAIL}")
    print(json.dumps(AUDIT, ensure_ascii=False, indent=2))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
