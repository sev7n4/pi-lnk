#!/usr/bin/env python3
"""静态判据：参数化 CDP 五层冒烟 runbook 的 V1–V7。

零外部依赖、确定性、可失败。只读脚本文本与 runbook，不连生产、不起 Chrome。
源级断言前一律 strip_comments，防止「把关键锚点只写在注释里」造成假绿。
"""
import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'scripts' / 'prod-cdp-smoke.mjs'
RUNBOOK = ROOT / 'docs' / 'ops' / '2026-11-09-prod-cdp-smoke-runbook.md'
WORKFLOWS = ROOT / '.github' / 'workflows'
PACKAGE = ROOT / 'package.json'

FORBIDDEN = [
    '119.29.173.89',
    ':8888',
    'cmw56hqit',
    'cmrn3ghmt',
    '/tmp/p0_token',
    'Emulation.setDeviceMetricsOverride',
]
EXPECTED_LAYERS = {'L0': 4, 'L1': 5, 'L2': 19, 'L3': 13, 'L4': 3}


def strip_comments(src: str) -> str:
    """逐字符扫描，区分 code / 行注释 / 块注释 / 三种引号字符串。"""
    out, i, n, state = [], 0, len(src), 'code'
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if state == 'code':
            if c == '/' and nxt == '/':
                state = 'line'; out.append('  '); i += 2; continue
            if c == '/' and nxt == '*':
                state = 'block'; out.append('  '); i += 2; continue
            if c in "'\"`":
                state = c; out.append(c); i += 1; continue
            out.append(c); i += 1; continue
        if state == 'line':
            if c == '\n': state = 'code'; out.append('\n')
            else: out.append(' ')
            i += 1; continue
        if state == 'block':
            if c == '*' and nxt == '/':
                state = 'code'; out.append('  '); i += 2; continue
            out.append('\n' if c == '\n' else ' '); i += 1; continue
        if c == '\\':
            out.append(c)
            if i + 1 < n: out.append(src[i + 1]); i += 2; continue
            i += 1; continue
        if c == state:
            state = 'code'; out.append(c); i += 1; continue
        out.append(c); i += 1; continue
    return ''.join(out)


def read(path):
    return path.read_text(encoding='utf-8') if path.is_file() else None


def function_body(code: str, name: str) -> str:
    m = re.search(r'(?:export\s+)?(?:async\s+)?function\s+' + re.escape(name) + r'\s*\(', code)
    if not m:
        return ''
    start = code.find('{', m.end())
    depth, i = 0, start
    while i < len(code):
        if code[i] == '{': depth += 1
        elif code[i] == '}':
            depth -= 1
            if depth == 0: return code[start:i + 1]
        i += 1
    return code[start:]


def group_v1(code, doc):
    if code is None: return False, '脚本缺失'
    hits = [w for w in FORBIDDEN if w in code]
    return not hits, ('禁词命中: ' + ', '.join(hits)) if hits else '零硬编码生产地址/会话/历史路径'


def group_v2(code, doc):
    if code is None or doc is None: return False, '脚本或 runbook 缺失'
    code_vars = set(re.findall(r'env\.(LNKPI_[A-Z_]+)', code)) | set(re.findall(r"'(LNKPI_[A-Z_]+)'", code))
    doc_vars = set(re.findall(r'`(LNKPI_[A-Z_]+)`', doc))
    missing_in_doc = sorted(code_vars - doc_vars)
    missing_in_code = sorted(doc_vars - code_vars)
    ok = not missing_in_doc and not missing_in_code and len(code_vars) == 16
    detail = f'code={len(code_vars)} doc={len(doc_vars)}'
    if missing_in_doc: detail += ' 文档缺: ' + ','.join(missing_in_doc)
    if missing_in_code: detail += ' 脚本缺: ' + ','.join(missing_in_code)
    return ok, detail


def group_v3(code, doc):
    if code is None: return False, '脚本缺失'
    body = function_body(code, 'assertPcViewport')
    problems = []
    if 'Browser.setWindowBounds' not in code: problems.append('缺 browser 级窗口修正')
    if '/json/close/' not in code: problems.append('缺重复 tab 清理')
    if 'list.find(' in code: problems.append('裸用 list.find 串台')
    if 'mobileShell !== false' not in body: problems.append('移动端壳层未硬断言')
    if 'LNKPI_MIN_PC_WIDTH' not in code: problems.append('缺 PC 断点变量')
    if 'P1 FAILED: browser-level bounds did not persist' not in code: problems.append('缺新 session 持久性复核')
    i_pre = code.find('await runPreflight(')
    i_layers = code.find('await runLayers(')
    if i_pre < 0 or i_layers < 0 or i_pre >= i_layers: problems.append('PREFLIGHT 未先于 runLayers')
    return not problems, '; '.join(problems) if problems else '三条 PREFLIGHT 齐备且先于判据'


def group_v4(code, doc):
    if code is None: return False, '脚本缺失'
    problems = []
    if "env.LNKPI_SMOKE_WRITE === '1'" not in code: problems.append('写开关不是显式 opt-in')
    if 'if (!cfg.write)' not in code: problems.append('缺只读分支')
    if "'L3_SKIPPED'" not in code: problems.append('缺 SKIPPED 判据')
    if "c.status === 'PASS'" not in code: problems.append('PASS 计数可能把 SKIP 算进去')
    return not problems, '; '.join(problems) if problems else 'L3 默认 SKIPPED 且 SKIP 不计 PASS'


def group_v5(code, doc):
    if code is None or doc is None: return False, '脚本或 runbook 缺失'
    ids = [m[1] for m in re.findall(r"add\('(L\d)',\s*'([^']+)'", code)]
    counts = {
        'L0': len([x for x in ids if x.startswith('L0_')]),
        'L1': len([x for x in ids if x.startswith('L1_')]),
        'L2': len([x for x in ids if re.match(r'^[AB]\d+_', x)]),
        'L3': len([x for x in ids if re.match(r'^C\d+_', x)]),
        'L4': len([x for x in ids if x.startswith('L4_')]),
    }
    problems = []
    for layer, want in EXPECTED_LAYERS.items():
        if counts[layer] != want: problems.append(f'{layer} 源码={counts[layer]} 期望={want}')
        if not re.search(r'\|\s*' + layer + r'\s*\|\s*' + str(want) + r'\s*\|', doc):
            problems.append(f'runbook 缺 {layer} | {want} 行')
    return not problems, '; '.join(problems) if problems else '五层 4/5/19/13/3 与 runbook 一致'


def group_v6(code, doc):
    hits = []
    for p in sorted(WORKFLOWS.glob('*.yml')) + sorted(WORKFLOWS.glob('*.yaml')):
        if 'prod-cdp-smoke' in p.read_text(encoding='utf-8'): hits.append(str(p.relative_to(ROOT)))
    if PACKAGE.is_file() and 'prod-cdp-smoke' in PACKAGE.read_text(encoding='utf-8'):
        hits.append('package.json')
    return not hits, ('CI/package 接线命中: ' + ','.join(hits)) if hits else '不挂 CI、不改 package.json'


def group_v7(code, doc):
    if doc is None: return False, 'runbook 缺失'
    needed = [
        'innerWidth=756', 'session-scoped', '/json/close/', '/json/list',
        '不挂 required check', 'Browser.setWindowBounds', 'LNKPI_SMOKE_WRITE=1',
    ]
    missing = [w for w in needed if w not in doc]
    return not missing, ('runbook 缺: ' + ','.join(missing)) if missing else '三条坑与不挂 CI 声明齐备'


GROUPS = [
    ('V1', group_v1), ('V2', group_v2), ('V3', group_v3), ('V4', group_v4),
    ('V5', group_v5), ('V6', group_v6), ('V7', group_v7),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='只跑指定组，如 V3')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    raw = read(SCRIPT)
    code = strip_comments(raw) if raw is not None else None
    doc = read(RUNBOOK)
    results = {}
    for name, fn in GROUPS:
        if args.only and name != args.only: continue
        ok, detail = fn(code, doc)
        results[name] = {'ok': ok, 'detail': detail}

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for name, r in results.items():
            print(f"{'PASS' if r['ok'] else 'FAIL'}  {name}  {r['detail']}")
        failed = [k for k, v in results.items() if not v['ok']]
        print('VERDICT ' + ('ALL_PASS' if not failed else 'HAS_FAILURE ' + ','.join(failed)))
    sys.exit(0 if all(v['ok'] for v in results.values()) else 1)


if __name__ == '__main__':
    main()
