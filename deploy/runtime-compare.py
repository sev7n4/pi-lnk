#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
K4：同 prompt 双 runtime 对比工具（spec §4.4.3 K4「自建 diff 工具」）

在 CVM 内部同时打两条链路，并排输出文本 + tool 调用差异：
  老链路  POST {old}/v1/runs            NDJSON（LangGraph，用户当前实际在使用）
  新链路  POST {pi}/sessions + SSE      pi-runtime（生产 shadow 目标）

为什么必须在 CVM 内部跑：老 runtime 只监听容器网络（172.20.0.4:8000，未 publish），
pi-runtime 是 K3s NodePort 30100（安全组未放行，外部不可达）。

用法：
  python3 runtime-compare.py --suite                 # 跑内置 3 条典型用例
  python3 runtime-compare.py --prompt "你好"          # 跑单条
  python3 runtime-compare.py --cases cases.json      # 跑批量（["..."] 或 [{"id","prompt"}]）
  python3 runtime-compare.py --report                # 汇总历史结果 → K4 diff 率

口径说明（与生产 shadow 对齐）：pi 侧只送用户原文（无 skill_id / 无附件 / 无画布上下文），
这正是 B4 的 mirrorToPiRuntime 在生产里发的 payload；老侧同样不送 skill_id / 附件。
老 runtime 内部仍会按 user_id 尝试加载画布上下文，因此两侧上下文并不完全对等——
K4 的绝对数值应视为「管线稳定性 + 输出漂移」参考，真正的语义对齐在 P1。
"""

import argparse
import difflib
import glob
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

DEFAULT_OLD_URL = "http://172.20.0.4:8000"
DEFAULT_PI_URL = "http://127.0.0.1:30100"
DEFAULT_OUT_DIR = "/opt/lnkpi/deploy/runtime-compare-out"
ENV_FILE = "/opt/lnkpi/.env"

BUILTIN_SUITE = [
    {"id": "chat", "prompt": "请用一句话介绍你自己"},
    {"id": "brief", "prompt": "帮我把「秋日限定拿铁上新」写成一句海报主标题"},
    {"id": "canvas", "prompt": "在画布上加一个圆形和一行文字「新品上市」"},
]


# --------------------------------------------------------------------------- #
# 基础设施
# --------------------------------------------------------------------------- #
def make_opener():
    """显式禁用环境代理（生产容器/宿主机有 HTTP_PROXY，会劫持内网 RPC）。"""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def read_env_token(explicit=None):
    if explicit:
        return explicit.strip()
    tok = os.environ.get("AGENT_RUNTIME_SERVICE_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(ENV_FILE, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.startswith("AGENT_RUNTIME_SERVICE_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def json_call(opener, method, url, payload=None, timeout=30, headers=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"content-type": "application/json", **(headers or {})},
    )
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, (json.loads(raw) if raw else None)
            except ValueError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except ValueError:
            return exc.code, body
    except Exception as exc:  # noqa: BLE001
        return 0, f"{type(exc).__name__}: {exc}"


def brief(value, limit=200):
    if value is None:
        return None
    try:
        return json.dumps(value, ensure_ascii=False)[:limit]
    except (TypeError, ValueError):
        return str(value)[:limit]


def extract_message_text(data):
    """从 pi 的 message_end / message_start payload 里尽量取出完整助手文本。"""
    msg = data.get("message") if isinstance(data, dict) else None
    if isinstance(msg, dict):
        content = msg.get("content")
    else:
        content = data.get("content") if isinstance(data, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            blk.get("text", "")
            for blk in content
            if isinstance(blk, dict) and blk.get("type") in ("text", "output_text")
        ]
        return "".join(parts)
    return ""


# --------------------------------------------------------------------------- #
# 老链路：LangGraph agent-runtime（NDJSON）
# --------------------------------------------------------------------------- #
def run_old(url, token, prompt, timeout, user_id="runtime-compare-user"):
    sid = "cmp-old-%d-%06d" % (int(time.time()), random.randrange(10 ** 6))
    res = {
        "sessionId": sid,
        "ok": False,
        "error": None,
        "elapsedMs": 0,
        "text": "",
        "textSource": None,
        "toolCalls": [],
        "eventCounts": {},
        "events": 0,
    }
    req = urllib.request.Request(
        url.rstrip("/") + "/v1/runs",
        data=json.dumps(
            {"session_id": sid, "user_id": user_id, "message": prompt, "thread_id": sid}
        ).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "accept": "application/x-ndjson",
            "x-lnkpi-service-token": token,
        },
        method="POST",
    )
    counts, replaces, deltas = res["eventCounts"], [], []
    started = time.time()
    try:
        with make_opener().open(req, timeout=timeout) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    counts["PARSE_FAIL"] = counts.get("PARSE_FAIL", 0) + 1
                    continue
                res["events"] += 1
                etype = ev.get("type") or "?"
                counts[etype] = counts.get(etype, 0) + 1
                data = ev.get("data") or {}
                if etype == "text_delta" and isinstance(data.get("text"), str):
                    deltas.append(data["text"])
                elif etype == "text_replace" and isinstance(data.get("text"), str):
                    replaces.append(data["text"])
                elif etype == "tool_call":
                    res["toolCalls"].append(
                        {
                            "name": data.get("name") or data.get("toolName") or "?",
                            "args": brief(data.get("arguments", data.get("args"))),
                        }
                    )
                elif etype == "error":
                    res["error"] = str(data.get("message") or data)[:300]
        res["ok"] = True
    except Exception as exc:  # noqa: BLE001
        res["error"] = "%s: %s" % (type(exc).__name__, exc)
    res["elapsedMs"] = int((time.time() - started) * 1000)
    if replaces:
        res["text"], res["textSource"] = replaces[-1], "text_replace"
    elif deltas:
        res["text"], res["textSource"] = "".join(deltas), "text_delta"
    return res


# --------------------------------------------------------------------------- #
# 新链路：pi-runtime（SSE）
# --------------------------------------------------------------------------- #
def _handle_pi_frame(state, ev_name, data_text):
    try:
        payload = json.loads(data_text)
    except ValueError:
        state["counts"]["PARSE_FAIL"] = state["counts"].get("PARSE_FAIL", 0) + 1
        return
    etype = payload.get("type") or ev_name or "?"
    state["counts"][etype] = state["counts"].get(etype, 0) + 1
    state["events"] += 1
    data = payload.get("data") or {}
    if etype == "message_update":
        inner = data.get("event") or data.get("assistantMessageEvent") or {}
        if inner.get("type") == "text_delta" and isinstance(inner.get("delta"), str):
            state["deltas"].append(inner["delta"])
    elif etype == "message_end":
        text = extract_message_text(data)
        if text:
            state["messageEnd"] = text
    elif etype == "tool_execution_start":
        state["toolCalls"].append(
            {"name": data.get("toolName") or "?", "args": brief(data.get("args"))}
        )
    elif etype == "agent_end":
        state["end"] = {"status": data.get("status"), "error": data.get("error")}
        state["stop"].set()
    elif etype == "error":
        state["error"] = brief(data, 300)


def run_pi(url, prompt, timeout, system_prompt=None, lane="main", keep_session=False):
    base = url.rstrip("/")
    sid = "cmp-pi-%d-%06d" % (int(time.time()), random.randrange(10 ** 6))
    res = {
        "sessionId": sid,
        "ok": False,
        "error": None,
        "elapsedMs": 0,
        "text": "",
        "textSource": None,
        "toolCalls": [],
        "eventCounts": {},
        "agentEnd": None,
        "events": 0,
    }
    opener = make_opener()
    started = time.time()
    status, payload = json_call(
        opener, "POST", base + "/sessions", {"sessionId": sid, "systemPrompt": system_prompt}, timeout
    )
    if status not in (201, 409):
        res["error"] = "createSession HTTP %s: %s" % (status, brief(payload, 200))
        res["elapsedMs"] = int((time.time() - started) * 1000)
        return res

    state = {
        "counts": {},
        "deltas": [],
        "toolCalls": [],
        "messageEnd": "",
        "end": None,
        "error": None,
        "events": 0,
        "stop": threading.Event(),
        "streamError": None,
    }

    def reader():
        try:
            req = urllib.request.Request(
                base + "/sessions/" + sid + "/events",
                headers={"accept": "text/event-stream"},
            )
            with opener.open(req, timeout=timeout) as resp:
                ev_name, data_lines = None, []
                for raw in resp:
                    if state["stop"].is_set():
                        break
                    line = raw.decode("utf-8", "replace").rstrip("\r\n")
                    if line == "":
                        if data_lines:
                            _handle_pi_frame(state, ev_name, "\n".join(data_lines))
                            ev_name, data_lines = None, []
                        if state["end"] is not None:
                            break
                        continue
                    if line.startswith(":"):
                        continue
                    if line.startswith("event:"):
                        ev_name = line[6:].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].strip())
        except Exception as exc:  # noqa: BLE001
            state["streamError"] = "%s: %s" % (type(exc).__name__, exc)
        finally:
            state["stop"].set()

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    time.sleep(0.3)  # 先订阅后 prompt（与 B4 同序，避免首帧竞态）

    pstatus, ppayload = json_call(
        opener, "POST", base + "/sessions/" + sid + "/prompt", {"text": prompt, "lane": lane}, timeout
    )
    if pstatus != 200:
        res["error"] = "prompt HTTP %s: %s" % (pstatus, brief(ppayload, 200))
        state["stop"].set()
    else:
        state["stop"].wait(timeout)
        if state["end"] is None:
            res["error"] = "timeout after %ss waiting agent_end" % timeout

    res["eventCounts"] = state["counts"]
    res["toolCalls"] = state["toolCalls"]
    res["events"] = state["events"]
    res["agentEnd"] = state["end"]
    res["elapsedMs"] = int((time.time() - started) * 1000)
    if state["error"]:
        res["error"] = state["error"]
    elif state["streamError"] and state["end"] is None:
        res["error"] = state["streamError"]

    joined = "".join(state["deltas"])
    if state["messageEnd"] and len(state["messageEnd"]) >= len(joined):
        res["text"], res["textSource"] = state["messageEnd"], "message_end"
    elif joined:
        res["text"], res["textSource"] = joined, "message_update_deltas"

    res["ok"] = state["end"] is not None or bool(res["text"])
    if not keep_session:
        json_call(opener, "DELETE", base + "/sessions/" + sid, None, timeout=15)
    return res


# --------------------------------------------------------------------------- #
# 对比
# --------------------------------------------------------------------------- #
def normalize(text):
    return re.sub(r"\s+", "", text or "")


def similarity(left, right):
    a, b = normalize(left), normalize(right)
    if not a and not b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def is_rate_limited(side):
    text = (side.get("error") or "").lower()
    return "429" in text or "rate limit" in text


def run_with_retry(fn, label, retries, backoff):
    """低配额 key（Agnes 免费版）极易 429，撞限流时退避重跑，避免污染 K4 样本。"""
    side = fn()
    attempt = 0
    while is_rate_limited(side) and attempt < retries:
        attempt += 1
        wait = backoff * attempt
        print("      [%s] 命中 429 限流，%ss 后重试 (%d/%d)" % (label, wait, attempt, retries))
        time.sleep(wait)
        side = fn()
    return side


def compare(old, pi, threshold):
    old_tools = [t["name"] for t in old["toolCalls"]]
    pi_tools = [t["name"] for t in pi["toolCalls"]]
    sim = similarity(old["text"], pi["text"])
    # 一侧报错（429/超时/断流）时文本相似度没有意义，不计入 K4 diff 率
    comparable = bool(old["ok"] and pi["ok"] and not old["error"] and not pi["error"])
    return {
        "comparable": comparable,
        "textSimilarity": round(sim, 4),
        "textEqual": normalize(old["text"]) == normalize(pi["text"]),
        "toolSeqEqual": old_tools == pi_tools,
        "toolsOnlyOld": sorted(set(old_tools) - set(pi_tools)),
        "toolsOnlyPi": sorted(set(pi_tools) - set(old_tools)),
        "oldToolSeq": old_tools,
        "piToolSeq": pi_tools,
        "latencyRatio": round(pi["elapsedMs"] / old["elapsedMs"], 3) if old["elapsedMs"] else None,
        "isDiff": (sim < threshold) or (old_tools != pi_tools),
    }


def snippet(text, limit=160):
    flat = re.sub(r"\s+", " ", (text or "").strip())
    return flat[:limit] + ("…" if len(flat) > limit else "")


def print_case(index, total, prompt, old, pi, diff, threshold):
    print("")
    print("=" * 78)
    print("case %d/%d  prompt: %s" % (index, total, snippet(prompt, 90)))
    print("-" * 78)
    for label, side in (("老链路 LangGraph :8000", old), ("新链路 pi-runtime :30100", pi)):
        flag = "OK " if side["ok"] else "ERR"
        print("%s %s | %sms | %d events | %s" % (
            flag, label, side["elapsedMs"], side["events"],
            json.dumps(side["eventCounts"], ensure_ascii=False),
        ))
        if side["error"]:
            print("      error: %s" % side["error"])
        print("      text[%s/%d]: %s" % (
            side["textSource"] or "none", len(side["text"]), snippet(side["text"]) or "(空)"
        ))
        if side["toolCalls"]:
            for call in side["toolCalls"]:
                print("      tool: %s  args=%s" % (call["name"], call["args"]))
        else:
            print("      tool: (无)")
    print("-" * 78)
    if not diff["comparable"]:
        verdict = "不可比（一侧报错，不计入 K4）"
    else:
        verdict = "异" if diff["isDiff"] else "同"
    print("diff: %s | 文本相似度 %.4f (阈值 %.2f) | 文本完全一致=%s" % (
        verdict, diff["textSimilarity"], threshold, diff["textEqual"]
    ))
    print("      tool 序列 老=%s 新=%s 一致=%s" % (
        diff["oldToolSeq"], diff["piToolSeq"], diff["toolSeqEqual"]
    ))
    if diff["toolsOnlyOld"] or diff["toolsOnlyPi"]:
        print("      仅老有=%s 仅新有=%s" % (diff["toolsOnlyOld"], diff["toolsOnlyPi"]))
    if diff["latencyRatio"] is not None:
        print("      耗时 新/老 = ×%.2f" % diff["latencyRatio"])


def percentile(values, pct):
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((pct / 100.0) * (len(ordered) - 1)))))
    return ordered[idx]


def cmd_report(out_dir, threshold):
    files = sorted(glob.glob(os.path.join(out_dir, "*.json")))
    rows = []
    for path in files:
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and "diff" in data:
            rows.append(data)
    if not rows:
        print("没有历史结果：%s/*.json 为空，先跑 --suite 或 --prompt" % out_dir)
        return 0

    total = len(rows)
    comparable = [r for r in rows if r["diff"].get("comparable")]
    invalid = total - len(comparable)
    rate_limited = sum(
        1 for r in rows if is_rate_limited(r["old"]) or is_rate_limited(r["pi"])
    )
    old_ok = sum(1 for r in rows if r["old"]["ok"])
    pi_ok = sum(1 for r in rows if r["pi"]["ok"])
    old_ms = [r["old"]["elapsedMs"] for r in rows if r["old"]["elapsedMs"]]
    pi_ms = [r["pi"]["elapsedMs"] for r in rows if r["pi"]["elapsedMs"]]
    tool_mismatch = sum(1 for r in comparable if not r["diff"]["toolSeqEqual"])

    print("=" * 78)
    print("K4 shadow diff 报告  (阈值≈相似度 < %.2f 或 tool 序列不一致 记为 diff)" % threshold)
    print("结果目录: %s   用例总数: %d" % (out_dir, total))
    print("-" * 78)
    print("老链路成功率      : %d/%d" % (old_ok, total))
    print("pi-runtime 成功率 : %d/%d" % (pi_ok, total))
    print("计入 K4 的样本    : %d/%d  (排除 %d 条一侧报错；其中 429 限流 %d 条)" % (
        len(comparable), total, invalid, rate_limited
    ))
    if comparable:
        sims = [r["diff"]["textSimilarity"] for r in comparable]
        diffs = [r for r in comparable if r["diff"]["isDiff"]]
        print("K4 diff 率        : %d/%d = %.1f%%   (spec 阈值 < 5%%)" % (
            len(diffs), len(comparable), 100.0 * len(diffs) / len(comparable)
        ))
        print("tool 序列不一致率 : %d/%d = %.1f%%" % (
            tool_mismatch, len(comparable), 100.0 * tool_mismatch / len(comparable)
        ))
        print("文本相似度        : min %.3f / p50 %.3f / mean %.3f" % (
            min(sims), percentile(sims, 50), sum(sims) / len(sims)
        ))
    else:
        print("K4 diff 率        : 无有效样本（两侧均需成功且无错误事件）")
    if old_ms and pi_ms:
        print("老链路耗时        : p50 %sms / p95 %sms" % (percentile(old_ms, 50), percentile(old_ms, 95)))
        print("pi 耗时           : p50 %sms / p95 %sms   (spec K3: p99 ≤ 老 × 1.5)" % (
            percentile(pi_ms, 50), percentile(pi_ms, 95)
        ))
    print("-" * 78)
    print("%-22s %-8s %-10s %-9s %s" % ("case", "sim", "diff", "耗时新/老", "note"))
    for row in rows:
        note = ",".join(row["diff"]["toolsOnlyOld"] + row["diff"]["toolsOnlyPi"]) or ""
        if is_rate_limited(row["old"]) or is_rate_limited(row["pi"]):
            note = (note + " 429").strip()
        elif row["old"]["error"] or row["pi"]["error"]:
            note = (note + " err").strip()
        if not row["diff"].get("comparable"):
            verdict = "不可比"
        else:
            verdict = "异" if row["diff"]["isDiff"] else "同"
        print("%-22s %-8.3f %-10s %-9s %s" % (
            snippet(row.get("caseId") or row.get("prompt", ""), 20),
            row["diff"]["textSimilarity"],
            verdict,
            ("×%.2f" % row["diff"]["latencyRatio"]) if row["diff"]["latencyRatio"] else "-",
            note,
        ))
    return 0


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #
def load_cases(args):
    if args.prompt:
        return [{"id": "cli", "prompt": args.prompt}]
    if args.cases:
        with open(args.cases, encoding="utf-8") as fh:
            raw = json.load(fh)
        cases = []
        for idx, item in enumerate(raw):
            if isinstance(item, str):
                cases.append({"id": "case%d" % (idx + 1), "prompt": item})
            elif isinstance(item, dict) and item.get("prompt"):
                cases.append({"id": item.get("id") or "case%d" % (idx + 1), "prompt": item["prompt"]})
        return cases
    return BUILTIN_SUITE


def main(argv=None):
    parser = argparse.ArgumentParser(description="K4 双 runtime 对比工具")
    parser.add_argument("--prompt", help="单条 prompt")
    parser.add_argument("--cases", help="批量用例 json 文件")
    parser.add_argument("--suite", action="store_true", help="跑内置 3 条用例（默认）")
    parser.add_argument("--report", action="store_true", help="汇总历史结果输出 K4 报告")
    parser.add_argument("--old-url", default=DEFAULT_OLD_URL)
    parser.add_argument("--pi-url", default=DEFAULT_PI_URL)
    parser.add_argument("--token", default=None, help="默认读 AGENT_RUNTIME_SERVICE_TOKEN 或 %s" % ENV_FILE)
    parser.add_argument("--timeout", type=int, default=180, help="单次运行超时秒数")
    parser.add_argument("--delay", type=float, default=3.0, help="两次运行之间的间隔秒数（默认 3，规避免费 key 限流）")
    parser.add_argument("--retries", type=int, default=2, help="命中 429 时的重试次数")
    parser.add_argument("--backoff", type=int, default=25, help="429 退避基数秒（第 n 次重试等 n×backoff）")
    parser.add_argument("--diff-threshold", type=float, default=0.85, help="相似度低于此值记为 diff")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    parser.add_argument("--pi-system", default=None, help="给 pi 会话注入 systemPrompt（实验用）")
    parser.add_argument("--pi-system-file", default=None, help="从文件读 systemPrompt")
    parser.add_argument("--keep-session", action="store_true", help="不删除 pi 会话（调试）")
    parser.add_argument("--json", action="store_true", help="仅输出 JSON")
    args = parser.parse_args(argv)

    if args.report:
        return cmd_report(args.out_dir, args.diff_threshold)

    token = read_env_token(args.token)
    if not token:
        print("警告：未取到 AGENT_RUNTIME_SERVICE_TOKEN，老链路 /v1/runs 可能 401", file=sys.stderr)

    system_prompt = args.pi_system
    if args.pi_system_file:
        with open(args.pi_system_file, encoding="utf-8") as fh:
            system_prompt = fh.read()

    cases = load_cases(args)
    os.makedirs(args.out_dir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    results = []

    for idx, case in enumerate(cases, 1):
        prompt = case["prompt"]
        if not args.json:
            print("\n>>> 运行 case %s …（老链路 + pi-runtime 串行，避免争抢 LLM 配额）" % case["id"])
        old = run_with_retry(
            lambda: run_old(args.old_url, token, prompt, args.timeout),
            "老链路",
            args.retries,
            args.backoff,
        )
        if args.delay:
            time.sleep(args.delay)
        pi = run_with_retry(
            lambda: run_pi(
                args.pi_url,
                prompt,
                args.timeout,
                system_prompt=system_prompt,
                keep_session=args.keep_session,
            ),
            "pi-runtime",
            args.retries,
            args.backoff,
        )
        if args.delay and idx < len(cases):
            time.sleep(args.delay)
        diff = compare(old, pi, args.diff_threshold)
        record = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "stamp": stamp,
            "caseId": case["id"],
            "prompt": prompt,
            "threshold": args.diff_threshold,
            "old": old,
            "pi": pi,
            "diff": diff,
        }
        results.append(record)
        with open(os.path.join(args.out_dir, "%s-%s.json" % (stamp, case["id"])), "w", encoding="utf-8") as fh:
            json.dump(record, fh, ensure_ascii=False, indent=2)
        if not args.json:
            print_case(idx, len(cases), prompt, old, pi, diff, args.diff_threshold)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0

    if len(results) > 1:
        comparable = [r for r in results if r["diff"]["comparable"]]
        diffs = [r for r in comparable if r["diff"]["isDiff"]]
        print("\n" + "=" * 78)
        if comparable:
            print("本轮 %d 个用例：有效 %d 个，diff %d 个 (%.1f%%)，结果已存 %s" % (
                len(results), len(comparable), len(diffs),
                100.0 * len(diffs) / len(comparable), args.out_dir,
            ))
        else:
            print("本轮 %d 个用例：无有效样本（一侧报错，多为 Agnes 免费 key 429 限流），结果已存 %s" % (
                len(results), args.out_dir,
            ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
