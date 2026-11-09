#!/usr/bin/env python3
"""静态判据：PC 会话页自动化视觉回归套件的 V1–V7。

零外部依赖、确定性、可失败。只读脚本文本、runbook、baseline 与 CI/包配置，
不连任何站点、不起 Chrome。源级断言前一律 strip_comments，防止「把关键锚点
只写在注释里」造成假绿（#4 M7 实证）。
"""
import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'scripts' / 'pc-visual-regression.mjs'
RUNBOOK = ROOT / 'docs' / 'ops' / '2026-11-09-pc-visual-regression-runbook.md'
FIXTURE = ROOT / 'scripts' / 'fixtures' / 'pc-visual-fixture.json'
FIXTURE_PAGE = ROOT / 'scripts' / 'fixtures' / 'pc-visual-page.html'
VITE_CONFIG = ROOT / 'scripts' / 'fixtures' / 'pc-visual.vite.config.mjs'
BASELINE = ROOT / 'scripts' / 'baselines' / 'pc-visual-baseline.json'
WORKFLOWS = ROOT / '.github' / 'workflows'
PACKAGE = ROOT / 'package.json'

FORBIDDEN = [
    '119.29.173.89',
    ':8888',
    'cmw56hqit',
    'cmrn3ghmt',
    '/tmp/p0_token',
    'deploy-cvm',
    'JWT_SECRET',
    'Emulation.setDeviceMetricsOverride',
]
EXPECTED_ENV_COUNT = 9
REQUIRED_ANCHORS_V7 = [
    'innerWidth=756',
    'session-scoped',
    '/json/list',
    '/json/close/',
    'Browser.setWindowBounds',
    '不挂 required check',
    'VERDICT ALL_PASS',
    'diff_count=0',
    'sha256',
    'PNG',
    'pc-visual-baseline.json',
]


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
    """零硬编码生产地址 / 会话 id / 历史路径，且必填 env 校验先于任何连接。"""
    if code is None: return False, '采集脚本缺失'
    hits = [w for w in FORBIDDEN if w in code]
    problems = ['禁词命中: ' + ', '.join(hits)] if hits else []
    main_body = function_body(code, 'main')
    i_cfg = main_body.find('readConfig(process.env)')
    i_pre = main_body.find('await runPreflight(')
    cfg_body = function_body(code, 'readConfig')
    if 'missing required env' not in cfg_body:
        problems.append('缺必填 env 缺失即抛错')
    if i_cfg < 0 or i_pre < 0 or i_cfg >= i_pre:
        problems.append('env 校验未先于 PREFLIGHT 连接')
    return not problems, '; '.join(problems) if problems else '零硬编码，env 校验先于任何连接'


def group_v2(code, doc):
    """env 名在脚本与 runbook 之间双向相等，且数量固定。"""
    if code is None or doc is None: return False, '采集脚本或 runbook 缺失'
    code_vars = set(re.findall(r'env\.(LNKPI_[A-Z_]+)', code)) | set(re.findall(r"'(LNKPI_[A-Z_]+)'", code))
    doc_vars = set(re.findall(r'`(LNKPI_[A-Z_]+)`', doc))
    missing_in_doc = sorted(code_vars - doc_vars)
    missing_in_code = sorted(doc_vars - code_vars)
    problems = []
    if missing_in_doc: problems.append('runbook 缺: ' + ','.join(missing_in_doc))
    if missing_in_code: problems.append('脚本缺: ' + ','.join(missing_in_code))
    if len(code_vars) != EXPECTED_ENV_COUNT:
        problems.append(f'env 数={len(code_vars)} 期望={EXPECTED_ENV_COUNT}')
    return not problems, '; '.join(problems) if problems else f'env 双向相等 {len(code_vars)} 项'


def group_v3(code, doc):
    """三条 PREFLIGHT 齐备且先于采集；注释里的锚点不算数。"""
    if code is None: return False, '采集脚本缺失'
    problems = []
    if 'Browser.setWindowBounds' not in code:
        problems.append('缺 browser 级窗口修正')
    if '/json/close/' not in code:
        problems.append('缺重复 tab 清理')
    if '/json/list' not in code:
        problems.append('缺 tab 枚举')
    if 'P1 FAILED: browser-level bounds did not persist' not in code:
        problems.append('缺新 session 持久性复核')
    body = function_body(code, 'runPreflight')
    if 'innerWidth' not in body:
        problems.append('PREFLIGHT 未复核 innerWidth')
    if 'LNKPI_MIN_PC_WIDTH' not in code:
        problems.append('缺 PC 断点变量')
    i_pre = code.find('await runPreflight(')
    i_cap = code.find('await captureSnapshot(')
    if i_pre < 0 or i_cap < 0 or i_pre >= i_cap:
        problems.append('PREFLIGHT 未先于采集')
    return not problems, '; '.join(problems) if problems else '三条 PREFLIGHT 齐备且先于采集'


def group_v4(code, doc):
    """确定性四固定 + 双跑 sha256 硬闸门。"""
    if code is None: return False, '采集脚本缺失'
    problems = []
    if len(re.findall(r'await captureSnapshot\(', code)) < 2:
        problems.append('采集未双跑')
    if 'DETERMINISM_OK' not in code:
        problems.append('缺确定性通过凭据')
    if 'shaA !== shaB' not in code:
        problems.append('缺双跑哈希不等即失败')
    for anchor in ['force-device-scale-factor', 'document.fonts.ready', 'requestAnimationFrame', 'createHash']:
        if anchor not in code:
            problems.append('固定性锚点缺失: ' + anchor)
    return not problems, '; '.join(problems) if problems else '双跑 sha256 + 四固定齐备'


def group_v5(code, doc):
    """diff 三类齐全、SKIP 不计 PASS、PNG 不进退出码、baseline 只读。"""
    if code is None: return False, '采集脚本缺失'
    problems = []
    diff_body = function_body(code, 'diffSnapshots')
    for kind in ["'added'", "'missing'", "'changed'"]:
        if kind not in diff_body:
            problems.append('diff 缺分类: ' + kind)
    if 'diff.length' not in code:
        problems.append('缺 diff_count 判据')
    if "c.status === 'PASS'" not in code:
        problems.append('PASS 计数可能把 SKIP 算进去')
    verdict = function_body(code, 'evaluateVerdict')
    if not verdict:
        problems.append('缺 evaluateVerdict 纯函数')
    elif re.search(r'shot|png|screenshot', verdict, re.I):
        problems.append('PNG/截图被接进退出码')
    if 'JSON.stringify' not in code:
        problems.append('缺确定性序列化')
    return not problems, '; '.join(problems) if problems else 'diff 三类 / SKIP 不计 PASS / PNG 不进退出码'


def group_v6(code, doc):
    """不挂 CI、不改 package.json；fixture 与 golden baseline 独立存在且可解析。"""
    hits = []
    for p in sorted(WORKFLOWS.glob('*.yml')) + sorted(WORKFLOWS.glob('*.yaml')):
        if 'pc-visual-regression' in p.read_text(encoding='utf-8'):
            hits.append(str(p.relative_to(ROOT)))
    if PACKAGE.is_file() and 'pc-visual-regression' in PACKAGE.read_text(encoding='utf-8'):
        hits.append('package.json')
    if hits:
        return False, 'CI/package 接线命中: ' + ','.join(hits)
    if not FIXTURE.is_file() or not FIXTURE_PAGE.is_file() or not VITE_CONFIG.is_file():
        return False, 'fixture 三件套缺失'
    if not BASELINE.is_file():
        return False, 'golden baseline 缺失'
    try:
        fixture = json.loads(FIXTURE.read_text(encoding='utf-8'))
        base = json.loads(BASELINE.read_text(encoding='utf-8'))
    except (ValueError, OSError) as e:
        return False, 'JSON 解析失败: ' + str(e)
    if 'presentation' not in fixture:
        return False, 'fixture 缺 presentation 载荷'
    if not isinstance(base, dict) or 'elements' not in base:
        return False, 'baseline 缺 elements 结构'
    if 'AgentPresentationHost.vue' not in FIXTURE_PAGE.read_text(encoding='utf-8'):
        return False, 'fixture page 未挂载真实 presentation 组件'
    return True, '零 CI 接线，fixture/page/config/baseline 齐备且真实组件参与渲染'


def group_v7(code, doc):
    """runbook 写明三条取证坑、四项准入凭据与不挂 CI 的理由。"""
    if doc is None: return False, 'runbook 缺失'
    missing = [w for w in REQUIRED_ANCHORS_V7 if w not in doc]
    if missing:
        return False, 'runbook 缺: ' + ','.join(missing)
    if '不得修改' not in doc and '不得同时修改' not in doc:
        return False, 'runbook 缺「删除刀不得改 baseline」契约'
    return True, '三条坑 + 四项准入凭据 + baseline 只读契约齐备'


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
