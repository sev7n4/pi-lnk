#!/usr/bin/env python3
"""VoiceStudio 活体冒烟探针（扩容后对生产 CVM VS 实例跑；也可对本机 spike 容器验证）。

锚：deploy/voicestudio/README.md §6 冒烟清单；spec §3.3/§3.4。
纪律：自带开跑归零 + 收尾归零（探针产物命名 lnk-smoke-<ts>，收尾尝试清理并打印残留）；
     判据只认服务端事实；--expect-engine 默认 audiocpp-dots（生产拍板引擎），
     对 spike 容器验证探针自身时用 --expect-engine omnivoice。

用法（在能直连 VS 的机器/容器内执行）：
  python3 deploy/voicestudio/smoke.py --host http://172.17.0.1:3900 --key <OMNIVOICE_API_KEY>
环境变量：OMNIVOICE_API_KEY 可替代 --key。
退出码：全 PASS=0，任一 FAIL=1（判据明细逐行打印）。
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def http(method, url, key, body=None, headers=None, timeout=330):
    req = urllib.request.Request(url, method=method)
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers or {})
    except Exception as e:
        return 0, str(e).encode(), {}


def mcp_call(url, key, method, params=None, session=None, timeout=330):
    """Streamable HTTP MCP: 单次 JSON-RPC；返回 (code, payload, session_id)。
    VS MCP 是有状态会话——initialize 响应头带 Mcp-Session-Id，后续请求必须携带，
    否则 "Bad Request: Missing session ID"。"""
    headers = {"Accept": "application/json, text/event-stream"}
    if session:
        headers["Mcp-Session-Id"] = session
    body = {"jsonrpc": "2.0", "id": str(uuid.uuid4())[:8], "method": method}
    if params is not None:
        body["params"] = params
    code, raw, rh = http("POST", url, key, body, headers, timeout)
    sid = None
    for k, v in rh.items():
        if k.lower() == "mcp-session-id":
            sid = v
            break
    text = raw.decode(errors="replace")
    payload = {"_raw": text[:400]}
    # SSE 形态（data: {...}）与裸 JSON 双兼容
    if text.startswith("event:") or "\ndata:" in text or text.startswith("data:"):
        for line in text.splitlines():
            if line.startswith("data:"):
                try:
                    payload = json.loads(line[5:].strip())
                    break
                except Exception:
                    pass
    else:
        try:
            payload = json.loads(text)
        except Exception:
            pass
    return code, payload, sid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="http://172.17.0.1:3900")
    ap.add_argument("--key", default=os.environ.get("OMNIVOICE_API_KEY", ""))
    ap.add_argument("--expect-engine", default="audiocpp-dots",
                    help="生产=audiocpp-dots（拍板引擎）；spike 容器验证用 omnivoice")
    ap.add_argument("--rtf-warn-sec", type=float, default=30.0,
                    help="17 字短句生成秒数警戒线（超=标注非实时批产，不判 FAIL）")
    args = ap.parse_args()
    H, K = args.host.rstrip("/"), args.key
    if not K:
        print("FAIL(前置) — 缺 API key（--key 或 OMNIVOICE_API_KEY）")
        return 1
    ts = uuid.uuid4().hex[:6]

    # ── 1. health（根路径，spec §4.1 vsRootBase 契约）─────────────────────
    code, raw, _ = http("GET", f"{H}/health", K, timeout=10)
    check("1.health", code == 200, f"HTTP {code}")

    # ── 2. 引擎面：拍板引擎可用 + OmniVoice 权重未安装 ─────────────────────
    code, raw, _ = http("GET", f"{H}/v1/models", K, timeout=30)
    models_txt = raw.decode(errors="replace") if code else ""
    check("2.models-endpoint", code == 200, f"HTTP {code}")
    check("2.engine-installed", args.expect_engine in models_txt,
          f"expect={args.expect_engine} in /v1/models")
    check("2.no-omnivoice-weights", "OmniVoice" not in models_txt,
          "OmniVoice 权重不落盘（NC 合规形态）" if "OmniVoice" not in models_txt else "⚠️ 发现 OmniVoice 相关条目，人工核对是否仅 active-engine 别名")

    # ── 3. 水印状态（§3.4 判据①）──────────────────────────────────────────
    code, raw, _ = http("GET", f"{H}/watermark/status", K, timeout=10)
    wm_ok, wm_detail = False, f"HTTP {code}"
    if code == 200:
        try:
            wm = json.loads(raw)
            wm_ok = bool(wm.get("available") or wm.get("enabled") or wm.get("audioseal_available"))
            wm_detail = json.dumps(wm)[:200]
        except Exception as e:
            wm_detail = f"parse fail: {e}"
    check("3.watermark-status", wm_ok, wm_detail + "（重建容器后须重跑 §4 补装）")

    # ── 4. TTS 直连出声 + RTF 实测 ────────────────────────────────────────
    t0 = time.time()
    code, raw, _ = http("POST", f"{H}/v1/audio/speech", K,
                        {"model": "omnivoice",  # pi-lnk P1 请求形态（透传 active engine）
                         "voice": "", "input": "画布上的这一段台词，用克隆的声线朗读。", "response_format": "wav"},
                        timeout=660)
    dt = time.time() - t0
    # voice 空：OpenAI 兼容层对空 voice 可能 400（引擎 preset 校验）——探针改用列表首音色重试
    if code != 200:
        code2, raw2, _ = http("GET", f"{H}/v1/audio/voices", K, timeout=30)
        try:
            voices = json.loads(raw2)
            first = (voices[0]["id"] if isinstance(voices, list) and voices else
                     (voices.get("voices") or [{}])[0].get("id", ""))
        except Exception:
            first = ""
        t0 = time.time()
        code, raw, _ = http("POST", f"{H}/v1/audio/speech", K,
                            {"model": "omnivoice", "voice": first,
                             "input": "画布上的这一段台词，用克隆的声线朗读。", "response_format": "wav"},
                            timeout=660)
        dt = time.time() - t0
    wav = raw if code == 200 else b""
    check("4.speech-200", code == 200, f"HTTP {code} bytes={len(wav)}")
    check("4.speech-wav", wav[:4] in (b"RIFF", b"\x1aE\xdf\xa3"), f"head={wav[:4]!r}")
    rtf_note = f"{dt:.1f}s/17字（警戒线 {args.rtf_warn_sec}s）"
    if code == 200 and dt > args.rtf_warn_sec:
        print(f"[NOTE] 4.rtf — {rtf_note} ⇒ 标注「非实时批产」场景（spec §8#1），不判 FAIL")
    elif code == 200:
        print(f"[NOTE] 4.rtf — {rtf_note} ✅ 实时可用区间")

    # ── 5. 水印 detect（§3.4 判据②：生成音频上传检测）─────────────────────
    det_ok, det_detail = False, "skipped(speech 未成功)"
    if wav[:4] == b"RIFF":
        boundary = uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"smoke.wav\"\r\n"
                f"Content-Type: audio/wav\r\n\r\n").encode() + wav + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(f"{H}/watermark/detect", data=body, method="POST")
        req.add_header("Authorization", f"Bearer {K}")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.loads(r.read())
            # confidence 字段名兼容多种形态；达标线以 status 返回结构为准
            conf = d.get("confidence", d.get("score", 0))
            det_ok = bool(d.get("detected") or (isinstance(conf, (int, float)) and conf > 0.5))
            det_detail = json.dumps(d)[:200]
        except urllib.error.HTTPError as e:
            det_detail = f"HTTP {e.code}: {e.read()[:150]!r}"
        except Exception as e:
            det_detail = f"error: {e}"
        if "Errno 99" in det_detail or "Errno 110" in det_detail:
            det_detail += "  ⇒ AudioSeal checkpoint 未缓存且容器内 HF 直连失败：容器内经 HF_ENDPOINT 镜像预下载 generator/detector_base.pth 后重验（runbook §4）"
    check("5.watermark-detect", det_ok, det_detail)

    # ── 6. MCP：initialize + 四工具在列 ──────────────────────────────────
    code, init, session = mcp_call(f"{H}/mcp/", K, "initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "lnkpi-smoke", "version": "1.0"},
    }, timeout=30)
    check("6.mcp-init", code == 200 and "result" in init,
          f"HTTP {code} session={'yes' if session else 'MISSING'}")
    code, tl, session = mcp_call(f"{H}/mcp/", K, "tools/list", {}, session=session, timeout=30)
    tool_names = [t.get("name") for t in (tl.get("result", {}).get("tools") or [])] if code == 200 else []
    need = ["clone_voice", "design_voice", "transcribe", "list_voices"]
    check("6.mcp-four-tools", all(n in tool_names for n in need),
          f"need={need} got={tool_names[:12]}")

    # ── 7. clone_voice 闭环（参考音频=步骤4的 wav，自证闭环）＋命名规范 ────
    clone_profile_id = None
    if wav[:4] == b"RIFF" and code == 200:
        ref_b64 = base64.b64encode(wav).decode()
        code, cr, _ = mcp_call(f"{H}/mcp/", K, "tools/call", {
            "name": "clone_voice",
            "arguments": {"name": f"lnk-smoke-{ts}", "ref_audio_base64": ref_b64,
                          "language": "zh"},
        }, session=session, timeout=400)
        payload = cr.get("result", {}).get("content", [{}])[0].get("text", "") if code == 200 else ""
        try:
            cj = json.loads(payload)
            clone_profile_id = cj.get("profile_id")
            check("7.clone-ok", bool(clone_profile_id), json.dumps(cj)[:160])
        except Exception:
            check("7.clone-ok", False, f"payload={payload[:160]!r}")
        if clone_profile_id:
            code, lv, _ = mcp_call(f"{H}/mcp/", K, "tools/call", {
                "name": "list_voices", "arguments": {},
            }, session=session, timeout=60)
            lv_txt = json.dumps(lv)
            check("7.clone-listed", clone_profile_id in lv_txt, "profile 出现在 list_voices")
            # 用克隆音色出声（闭环终点：profile_id → voice 参数 → 出声）
            code2, gen, _ = http("POST", f"{H}/v1/audio/speech", K,
                                 {"model": "omnivoice", "voice": clone_profile_id,
                                  "input": "这是克隆声线的验证。", "response_format": "wav"},
                                 timeout=660)
            check("7.clone-synthesizes", code2 == 200 and gen[:4] == b"RIFF",
                  f"HTTP {code2} bytes={len(gen)}")
            # 收尾归零：删探针 profile（DELETE /profiles/{id}；失败打印残留不阻断）
            dcode, _, _ = http("DELETE", f"{H}/profiles/{clone_profile_id}", K, timeout=30)
            if dcode in (200, 204, 404):
                print(f"[NOTE] 7.cleanup — 探针 profile 已清理（HTTP {dcode}）")
            else:
                print(f"[NOTE] 7.cleanup — 删除 HTTP {dcode}，残留 profile={clone_profile_id}（人工清理）")
    else:
        check("7.clone-ok", False, "skipped(speech 未出声/MCP 未通)")

    # ── 8. design_voice 行为记录（audiocpp-dots 无 design 能力，只登记不判死）──
    code, dv, _ = mcp_call(f"{H}/mcp/", K, "tools/call", {
        "name": "design_voice",
        "arguments": {"name": f"lnk-smoke-design-{ts}",
                      "description": "young adult female, moderate pitch, warm voice", "language": "en"},
    }, session=session, timeout=120)
    dv_txt = json.dumps(dv)[:220]
    print(f"[NOTE] 8.design-voice — HTTP {code} {dv_txt}（行为登记：支持=渲染样本 / 拒绝=fallback 形态，人工归档）")
    # design profile 清理
    try:
        dj = json.loads(dv.get("result", {}).get("content", [{}])[0].get("text", "") or "{}")
        if dj.get("profile_id"):
            http("DELETE", f"{H}/profiles/{dj['profile_id']}", K, timeout=30)
    except Exception:
        pass

    # ── 汇总 ─────────────────────────────────────────────────────────────
    print(f"\n===== SMOKE {len(PASS)}/{len(PASS)+len(FAIL)} PASS =====")
    if FAIL:
        print("FAIL 列表: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
