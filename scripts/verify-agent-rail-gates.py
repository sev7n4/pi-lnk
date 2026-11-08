#!/usr/bin/env python3
"""Phase 4 / #3 P4：AgentSideRail 契约门禁（零外部依赖、可失败）。

用法：
  python3 scripts/verify-agent-rail-gates.py

判据组：
  G1  defineExpose 11 项冻结契约集合 + 与 vitest ratchet 常量一致
  G2  注入点顶层键集合 ⇄ *Deps 接口属性集合 双向配对
  G3  注入点总数 / 顶层键总数 / 回调型键总数 / 每簇键数 四项棘轮 + 白名单
  G4  ratchet 健康度：readFileSync 目标存在、新 ratchet 存在、两处契约集合一致
  G5  CI 接线：ci.yml 的 spec-figures job 与 package.json 的 script

准入三问（见规格 §4.1）：零外部依赖、确定性、可失败。本脚本只读仓库内
源文件，使用 Python 标准库，不访问网络、不读密钥、不启浏览器。

基线为 master 8424bb02 的机器精算结果，见规格 §3.2 / §8。数值只许减少，
增加时必须显式更新本表并写明理由（棘轮语义）。
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
AGENT = ROOT / "apps/web/src/components/agent"
SFC = AGENT / "AgentSideRail.vue"
RATCHET = AGENT / "AgentSideRail.defineExpose.test.ts"
CI = ROOT / ".github/workflows/ci.yml"
PACKAGE = ROOT / "package.json"
SELF = ROOT / "scripts/verify-agent-rail-gates.py"

GATE_NAME = "verify-agent-rail-gates"

# ------------------------------------------------------------------ 基线常量
FROZEN_EXPOSE_KEYS = (
    "newAgentSession", "openThreadHistory", "closeThreadHistory",
    "openPanel", "closePanel", "setComposerInput", "addAttachment",
    "reconcileFromNodes", "confirmProposeWait", "cancelProposeForNode",
    "addFromCanvasNodes",
)

INJECTION_BASELINE: dict[str, int] = {
    "useAgentComposer": 11,
    "useAgentMessageActions": 9,
    "useAgentPropose": 5,
    "useAgentStream": 1,
    "useAgentDock": 10,
    "useAgentQueue": 11,
    "useUtteranceRotation": 5,
    "useAgentObserver": 12,
    "useNetworkNotice": 1,
    "useAgentThread": 16,
}
MAX_INJECTION_POINTS = 10
MAX_TOTAL_KEYS = 81
MAX_CALLBACK_KEYS = 17

_results: list[tuple[str, bool, str]] = []


def record(group: str, ok: bool, detail: str) -> None:
    _results.append((group, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'} {group}: {detail}")


def read(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


# ------------------------------------------------------------ 源码解析工具
def matching_brace(src: str, open_idx: int) -> int:
    """从 '{' 起配平，跳过注释/字符串/模板串，返回闭合下标。"""
    depth = 0
    i = open_idx
    n_len = len(src)
    while i < n_len:
        c = src[i]
        n = src[i + 1] if i + 1 < n_len else ""
        if c == "/" and n == "/":
            j = src.find("\n", i)
            i = n_len if j < 0 else j
            continue
        if c == "/" and n == "*":
            j = src.find("*/", i + 2)
            i = n_len if j < 0 else j + 2
            continue
        if c in "'\"`":
            q = c
            i += 1
            while i < n_len:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == q:
                    i += 1
                    break
                i += 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def split_entries(body: str) -> list[str]:
    """按深度 0 的逗号切分对象条目，保留完整 'key: value' 文本。"""
    out: list[str] = []
    cur = ""
    depth = 0
    i = 0
    n_len = len(body)
    while i < n_len:
        c = body[i]
        n = body[i + 1] if i + 1 < n_len else ""
        if c == "/" and n == "/":
            j = body.find("\n", i)
            i = n_len if j < 0 else j
            continue
        if c == "/" and n == "*":
            j = body.find("*/", i + 2)
            i = n_len if j < 0 else j + 2
            continue
        if c in "'\"`":
            q = c
            cur += c
            i += 1
            while i < n_len:
                cur += body[i]
                if body[i] == "\\":
                    cur += body[i + 1] if i + 1 < n_len else ""
                    i += 2
                    continue
                if body[i] == q:
                    i += 1
                    break
                i += 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        if c == "," and depth == 0:
            if cur.strip():
                out.append(cur.strip())
            cur = ""
        else:
            cur += c
        i += 1
    if cur.strip():
        out.append(cur.strip())
    return out


def top_colon(entry: str) -> int:
    depth = 0
    for i, c in enumerate(entry):
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == ":" and depth == 0:
            return i
    return -1


def entry_key(entry: str) -> str:
    k = top_colon(entry)
    return (entry[:k] if k >= 0 else entry).strip()


def strip_comments(s: str) -> str:
    return re.sub(r"//[^\n]*", "", re.sub(r"/\*[\s\S]*?\*/", "", s))


def injection_points(sfc: str) -> dict[str, list[str]]:
    """返回 {useXxx: [顶层键名...]}，同名多次出现合并。"""
    out: dict[str, list[str]] = {}
    for m in re.finditer(r"\b(use[A-Z]\w+)\s*\(\s*\{", sfc):
        name = m.group(1)
        open_idx = sfc.find("{", m.start())
        close = matching_brace(sfc, open_idx)
        if close < 0:
            out.setdefault(name, []).append("__UNBALANCED__")
            continue
        body = sfc[open_idx + 1:close]
        keys = [entry_key(e) for e in split_entries(body)]
        out.setdefault(name, []).extend(k for k in keys if k)
    return out


def callback_keys(sfc: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for m in re.finditer(r"\b(use[A-Z]\w+)\s*\(\s*\{", sfc):
        name = m.group(1)
        open_idx = sfc.find("{", m.start())
        close = matching_brace(sfc, open_idx)
        if close < 0:
            continue
        for e in split_entries(sfc[open_idx + 1:close]):
            if "=>" in e:
                out.setdefault(name, []).append(entry_key(e))
    return out


def interface_props(body: str) -> set[str]:
    """只取接口体顶层属性；逐行追踪括号深度，忽略多行函数签名里的参数。

    ⚠️ 不能用 `^\\s{2,4}(\\w+)\\??\\s*:` 配 re.M —— `\\s` 含换行，会跨行命中
    `makeAttachmentItems: (attachments: ...)` 之类签名里的参数名，造成假差异。
    """
    body = strip_comments(body)
    props: set[str] = set()
    depth = 0
    for line in body.splitlines():
        if depth == 0:
            m = re.match(r"^(\w+)\??\s*:", line.strip())
            if m:
                props.add(m.group(1))
        for c in line:
            if c in "([{":
                depth += 1
            elif c in ")]}":
                depth -= 1
    return props


def deps_interfaces() -> dict[str, set[str]]:
    """扫描 agent 目录 .ts 文件里的 interface *Deps*，按文件名（去 .ts）索引。"""
    out: dict[str, set[str]] = {}
    for path in sorted(AGENT.glob("*.ts")):
        if path.name.endswith(".test.ts"):
            continue
        s = path.read_text(encoding="utf-8")
        for m in re.finditer(r"(?:export\s+)?interface\s+(\w*Deps\w*)\s*\{", s):
            open_idx = s.find("{", m.start())
            close = matching_brace(s, open_idx)
            if close < 0:
                continue
            out[path.stem] = interface_props(s[open_idx + 1:close])
    return out


def expose_block(sfc: str) -> tuple[list[str], str]:
    i = sfc.find("defineExpose({")
    if i < 0:
        return [], ""
    open_idx = sfc.find("{", i)
    close = matching_brace(sfc, open_idx)
    if close < 0:
        return [], ""
    body = sfc[open_idx + 1:close]
    return [entry_key(e) for e in split_entries(body)], body


# ------------------------------------------------------------------ G1
def g1_expose(sfc: str, ratchet: str) -> None:
    keys, _ = expose_block(sfc)
    ok = set(keys) == set(FROZEN_EXPOSE_KEYS) and len(keys) == len(FROZEN_EXPOSE_KEYS)
    record("G1_expose_frozen_contract", ok,
           f"sfc_keys={len(keys)} expected={len(FROZEN_EXPOSE_KEYS)} "
           f"missing={sorted(set(FROZEN_EXPOSE_KEYS) - set(keys))} extra={sorted(set(keys) - set(FROZEN_EXPOSE_KEYS))}")
    # 与 vitest ratchet 内的常量保持一致，防止两处基线漂移
    declared = re.search(r"const FROZEN_EXPOSE_KEYS = \[([\s\S]*?)\]\s*as const", ratchet)
    names = set(re.findall(r"'([A-Za-z_$][\w$]*)'", declared.group(1))) if declared else set()
    record("G1_ratchet_constant_aligned", names == set(FROZEN_EXPOSE_KEYS),
           f"ratchet_declared={len(names)} verifier={len(FROZEN_EXPOSE_KEYS)}")


# ------------------------------------------------------------------ G2
def g2_pairing(points: dict[str, list[str]], deps: dict[str, set[str]]) -> None:
    problems: list[str] = []
    paired = 0
    for name, keys in points.items():
        if name not in deps:
            continue  # 无接口注入点由 G3 白名单与计数兜住
        paired += 1
        got, want = set(keys), deps[name]
        if got != want:
            problems.append(f"{name}: missing_in_sfc={sorted(want - got)} missing_in_iface={sorted(got - want)}")
    record("G2_injection_vs_deps_pairing", paired >= 6 and not problems,
           f"paired_interfaces={paired} problems={problems or 'none'}")
    record("G2_no_unbalanced_blocks", all("__UNBALANCED__" not in v for v in points.values()),
           f"points={len(points)}")


# ------------------------------------------------------------------ G3
def g3_ratchet(points: dict[str, list[str]], cbs: dict[str, list[str]]) -> None:
    total = sum(len(v) for v in points.values())
    cb_total = sum(len(v) for v in cbs.values())
    names = set(points)
    over = {k: len(v) for k, v in points.items()
            if len(v) > INJECTION_BASELINE.get(k, 0)}
    unknown = sorted(names - set(INJECTION_BASELINE))
    record("G3_injection_point_whitelist", not unknown and len(names) <= MAX_INJECTION_POINTS,
           f"points={len(names)}/{MAX_INJECTION_POINTS} unknown={unknown}")
    record("G3_total_keys_ratchet", total <= MAX_TOTAL_KEYS and not over,
           f"total={total}/{MAX_TOTAL_KEYS} over_baseline={over}")
    record("G3_callback_keys_ratchet", cb_total <= MAX_CALLBACK_KEYS,
           f"callback_keys={cb_total}/{MAX_CALLBACK_KEYS} by_point={ {k: len(v) for k, v in cbs.items()} }")


# ------------------------------------------------------------------ G4
def g4_ratchet_health() -> None:
    tests = sorted(AGENT.glob("AgentSideRail.*.test.ts"))
    missing: list[str] = []
    checked = 0
    for t in tests:
        s = t.read_text(encoding="utf-8")
        # readFileSync(join(here, './X.vue'), ...) 或 readFileSync(join(here, 'X.ts'), ...)
        for rel in re.findall(r"readFileSync\(\s*join\(\s*here\s*,\s*['\"]([^'\"]+)['\"]", s):
            checked += 1
            target = (AGENT / rel).resolve()
            if not target.is_file():
                missing.append(f"{t.name} -> {rel}")
    record("G4_ratchet_source_targets_exist", bool(tests) and checked > 0 and not missing,
           f"tests={len(tests)} references={checked} missing={missing or 'none'}")
    record("G4_defineExpose_ratchet_present", RATCHET.is_file() and "FROZEN_EXPOSE_KEYS" in read(RATCHET),
           f"ratchet={RATCHET.name} exists={RATCHET.is_file()}")


# ------------------------------------------------------------------ G5
def g5_ci_wiring() -> None:
    ci = read(CI)
    m = re.search(r"^  spec-figures:\s*$[\s\S]*?(?=^  \w[\w-]*:\s*$)", ci, re.M)
    job = m.group(0) if m else ""
    step_ok = bool(job) and f"pnpm {GATE_NAME}" in job
    record("G5_ci_spec_figures_step", step_ok,
           f"job_found={bool(job)} has_step={f'pnpm {GATE_NAME}' in job}")
    try:
        scripts = json.loads(read(PACKAGE)).get("scripts", {})
    except json.JSONDecodeError:
        scripts = {}
    script_ok = GATE_NAME in scripts and SELF.name in scripts.get(GATE_NAME, "")
    record("G5_package_script_wired", script_ok and SELF.is_file(),
           f"script={scripts.get(GATE_NAME)} self_exists={SELF.is_file()}")


def main() -> int:
    sfc = strip_comments(read(SFC))
    ratchet = read(RATCHET)
    if not sfc:
        print("FATAL: cannot read AgentSideRail.vue", file=sys.stderr)
        return 2
    points = injection_points(sfc)
    cbs = callback_keys(sfc)
    deps = deps_interfaces()

    g1_expose(sfc, ratchet)
    g2_pairing(points, deps)
    g3_ratchet(points, cbs)
    g4_ratchet_health()
    g5_ci_wiring()

    failed = [g for g, ok, _ in _results if not ok]
    print(f"\nSUMMARY: {len(_results) - len(failed)}/{len(_results)} passed; failed={failed or 'none'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
