#!/usr/bin/env python3
"""静态判据：isMobileLayout 读取域棘轮门禁 V1–V6。

零外部依赖、确定性、可失败。只读源码文本与 CI 配置，不解析 Vue、不起浏览器、不连网络。
源级计数一律先 strip_comments，防止「把锚点只写在注释里」造成假绿。

⚠️ 判据自匹配防护：所有「源码含某锚点」的断言只看 implementation_code()，
即剔除 group_v* 判据函数体之后的实现代码；否则断言字面量写在判据自身里会恒绿，
任何变异都不会 RED（伪变异）。

用法：
  python3 scripts/verify-is-mobile-layout-scope.py
  python3 scripts/verify-is-mobile-layout-scope.py --root /tmp/sandbox-tree --json
"""
import argparse
import json
import pathlib
import re
import sys

REAL_ROOT = pathlib.Path(__file__).resolve().parent.parent
SELF = pathlib.Path(__file__).resolve()
# 上限取「剥离注释后」的有效读取点数，而非 grep 的行数：
# grep 计到 22 行，其中 1 行是文档注释 ⇒ 真实基线 21。留余量会让「多一处读取」的变异被吞掉。
MAX_ALLOWED = 21
GATE_CMD = 'python3 scripts/verify-is-mobile-layout-scope.py'
STDLIB_ONLY = {'argparse', 'json', 'pathlib', 're', 'sys', 'collections', 'difflib', 'hashlib'}
SCAN_SUFFIXES = {'.vue', '.ts', '.tsx', '.js', '.mjs'}


# ------------------------------------------------------------- 实现层（被测） ----

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


def strip_yaml_comments(text):
    """逐行去掉 YAML 的整行/行尾注释；引号内的 # 保留。"""
    out = []
    for line in (text or '').split('\n'):
        quote, cut = None, None
        for i, c in enumerate(line):
            if quote:
                if c == quote: quote = None
            elif c in "'\"":
                quote = c
            elif c == '#':
                cut = i
                break
        out.append(line if cut is None else line[:cut])
    return '\n'.join(out)


def read(path):
    return path.read_text(encoding='utf-8') if path.is_file() else None


def count_hits(text):
    plain = re.sub(r'<!--.*?-->', '', text or '', flags=re.S)
    return len(re.findall(r'\bisMobileLayout\b', strip_comments(plain)))


def scan_tree(root, subdirs):
    hits = {}
    for sub in subdirs:
        base = root / sub
        if not base.is_dir():
            continue
        for p in sorted(base.rglob('*')):
            if p.is_file() and p.suffix in SCAN_SUFFIXES:
                n = count_hits(read(p))
                if n:
                    hits[str(p.relative_to(root))] = n
    return hits


def spec_figures_job(ci_text):
    lines = (ci_text or '').split('\n')
    start = None
    for i, line in enumerate(lines):
        if re.match(r'^  spec-figures:\s*$', line):
            start = i
            break
    if start is None:
        return ''
    for j in range(start + 1, len(lines)):
        if re.match(r'^  [A-Za-z0-9_-]+:\s*$', lines[j]):
            return '\n'.join(lines[start:j])
    return '\n'.join(lines[start:])


def within_ratchet(count, limit):
    """棘轮方向：只降不升。判据 V3 单独检查本函数体，防方向被改写。"""
    return count <= limit


def function_body(code, name):
    """Python 专用：从签名行末尾截到下一个顶层定义，不按花括号（那是 JS 范式）。"""
    m = re.search(r'def\s+' + re.escape(name) + r'\s*\(', code)
    if not m:
        return ''
    start = code.find('\n', m.end())
    if start < 0:
        return ''
    tail = code[start:]
    nxt = re.search(r'\n(?=def |GROUPS|if __name__|MAX_ALLOWED)', tail)
    return tail[:nxt.start()] if nxt else tail


def implementation_code(code):
    """剔除判据函数体，只留实现层，避免判据字面量自匹配造成恒绿。"""
    out = code
    for name in ['group_v1', 'group_v2', 'group_v3', 'group_v4', 'group_v5', 'group_v6']:
        body = function_body(out, name)
        if body:
            out = out.replace(body, '', 1)
    return out


# --------------------------------------------------------------- 判据层 ----

def group_v1(impl, ctx):
    mods = set(re.findall(r'^import\s+([A-Za-z0-9_]+)', impl, re.M)) \
        | set(re.findall(r'^from\s+([A-Za-z0-9_]+)\s+import', impl, re.M))
    extra = sorted(mods - STDLIB_ONLY)
    return not extra, ('非标准库依赖: ' + ','.join(extra)) if extra else '零外部依赖（Python 标准库）'


def group_v2(impl, ctx):
    hits = ctx['content_hits']
    if not ctx['has_content_dirs']:
        return False, '零容忍目录缺失，扫描面不成立'
    return not hits, ('Content/shared 命中: ' + json.dumps(hits, ensure_ascii=False)) if hits else 'presentation 与 packages/shared 零读取'


def group_v3(impl, ctx):
    problems = []
    if ctx['sfc_count'] is None:
        problems.append('AgentSideRail.vue 缺失')
    elif not within_ratchet(ctx['sfc_count'], MAX_ALLOWED):
        problems.append(f'Shell 读取点 {ctx["sfc_count"]} 超过上限 {MAX_ALLOWED}')
    ratchet = function_body(impl, 'within_ratchet')
    if 'count <= limit' not in ratchet:
        problems.append('棘轮方向判据被改写或删除')
    if not re.search(r'^MAX_ALLOWED = 21$', impl, re.M):
        problems.append('上限常量来源丢失')
    return not problems, '; '.join(problems) if problems else f'Shell 读取点 {ctx["sfc_count"]} <= {MAX_ALLOWED}，方向判据在位'


def group_v4(impl, ctx):
    if ctx['sfc_text'] is None:
        return False, 'AgentSideRail.vue 缺失'
    defs = len(re.findall(r'useAgentMobileLayout\s*\(', strip_comments(ctx['sfc_text'])))
    ok = defs == 1
    return ok, f'useAgentMobileLayout() 定义点 {defs}，期望 1' if not ok else '唯一布局断点定义点'


def group_v5(impl, ctx):
    job = spec_figures_job(ctx['ci_text'])
    if not job:
        return False, 'ci.yml 缺 spec-figures job'
    if 'def strip_yaml_comments' not in impl:
        return False, 'CI 判据缺 YAML 注释剥离实现'
    if GATE_CMD not in strip_yaml_comments(job):
        return False, 'spec-figures job 未挂载本门禁'
    return True, '门禁挂在既有 spec-figures job，未新建 job'


def group_v6(impl, ctx):
    problems = []
    if 'def strip_comments' not in impl:
        problems.append('缺 strip_comments')
    main_body = function_body(impl, 'main')
    if 'count_hits(sfc_text)' not in main_body:
        problems.append('Shell 计数未走统一入口')
    if 'scan_tree(root,' not in main_body:
        problems.append('零容忍区未走递归扫描')
    if 're.sub' not in function_body(impl, 'count_hits'):
        problems.append('HTML 模板注释未剥离')
    return not problems, '; '.join(problems) if problems else '注释剥离与统一计数入口在位'


GROUPS = [
    ('V1', group_v1), ('V2', group_v2), ('V3', group_v3),
    ('V4', group_v4), ('V5', group_v5), ('V6', group_v6),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=str(REAL_ROOT), help='扫描根，变异测试可指向沙箱树')
    ap.add_argument('--only', help='只跑指定组，如 V3')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    root = pathlib.Path(args.root).resolve()
    sfc = root / 'apps/web/src/components/agent/AgentSideRail.vue'
    pres = root / 'apps/web/src/components/agent/presentation'
    shared = root / 'packages/shared'
    ci = root / '.github/workflows/ci.yml'
    sfc_text = read(sfc)
    ctx = {
        'sfc_text': sfc_text,
        'sfc_count': count_hits(sfc_text) if sfc_text is not None else None,
        'content_hits': scan_tree(root, [
            pathlib.Path('apps/web/src/components/agent/presentation'),
            pathlib.Path('packages/shared'),
        ]),
        'has_content_dirs': pres.is_dir() and shared.is_dir(),
        'ci_text': read(ci),
    }
    impl = implementation_code(SELF.read_text(encoding='utf-8'))
    results = {}
    for name, fn in GROUPS:
        if args.only and name != args.only: continue
        ok, detail = fn(impl, ctx)
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
