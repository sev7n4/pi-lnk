#!/usr/bin/env python3
"""Phase 4 删除域棘轮判据（路线 ① 第一刀）。

定位：把母规格 §9「删 presentation/ 下 PC 冗余渲染」的删除对象，从主观行数
描述变成可机检、可失败、确定性的工程契约。本脚本零外部依赖（Python 标准库），
只读源码文本、manifest 与 CI/规格文档，不解析 Vue、不起浏览器、不连网络。

真值纪律：删除清单必须来自 true master 源码，不采信本地并行工作树。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys

REAL_ROOT = pathlib.Path(__file__).resolve().parent.parent
SELF = pathlib.Path(__file__).resolve()

TARGET_DIR = pathlib.Path('apps/web/src/components/agent/presentation')
SRC_ROOT = pathlib.Path('apps/web/src')
MANIFEST = pathlib.Path('scripts/fixtures/phase4-delete-scope-manifest.json')
MOTHER_SPEC = pathlib.Path('docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md')
CI = pathlib.Path('.github/workflows/ci.yml')
RUNBOOK = pathlib.Path('docs/ops/2026-11-09-phase4-delete-scope-runbook.md')
DESIGN = pathlib.Path('docs/superpowers/specs/2026-11-09-phase4-delete-scope-rebaseline-design.md')

GATE_CMD = 'python3 scripts/verify-phase4-delete-scope.py'
NO_DELETE = 'NO_DELETE_TARGET'
SHARED_ANCHORS = ('NodeTileView.vue', 'NodeViewerView.vue')
GUARD_MOUNT = 'AgentPresentationHost.vue'
SOURCE_EXTS = ('.vue', '.ts', '.tsx', '.js')


# --------------------------------------------------------------- 基础层 ----

def read(path: pathlib.Path):
    try:
        return path.read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        return None


def strip_comments(src: str) -> str:
    """剥离 JS/TS/Vue 的行注释、块注释与 HTML 注释，防止注释里的锚点造成假绿。"""
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    out = []
    for line in src.split('\n'):
        # 保守处理：只剥离行首/空白后的 //，避免误伤 URL 字符串中的 //
        m = re.match(r'^(\s*)//', line)
        if m:
            continue
        out.append(line)
    return '\n'.join(out)


def strip_yaml_comments(text: str) -> str:
    """剥离 YAML 行注释，但保留引号内的 #（防注释伪装 CI 挂载）。"""
    out = []
    for line in text.split('\n'):
        quote = None
        cut = len(line)
        for i, ch in enumerate(line):
            if quote:
                if ch == quote:
                    quote = None
            elif ch in ('"', "'"):
                quote = ch
            elif ch == '#' and (i == 0 or line[i - 1].isspace()):
                cut = i
                break
        out.append(line[:cut].rstrip())
    return '\n'.join(out)


def spec_figures_job(ci_text: str) -> str:
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


def source_files(root: pathlib.Path):
    base = root / SRC_ROOT
    result = {}
    if not base.is_dir():
        return result
    for p in base.rglob('*'):
        if p.is_file() and (p.suffix in SOURCE_EXTS or p.name.endswith('.snap')):
            result[p.relative_to(root).as_posix()] = read(p)
    return {k: v for k, v in result.items() if v is not None}


def is_production(path: str) -> bool:
    return '.test.' not in path and '__snapshots__' not in path and not path.endswith('.snap')


def reference_pattern(stem: str, ext: str) -> re.Pattern:
    if ext == '.vue':
        # 组件名作为标识符/标签出现；组件名在仓库内具有唯一性
        return re.compile(r'(?<![\w])' + re.escape(stem) + r'(?![\w])')
    # 模块引用一律按路径片段判定，避免 `types` 这类泛用词裸匹配造成假引用
    return re.compile(r"""['"][^'"]*(?:/|\.)""" + re.escape(stem) + r"""['"]""")


def compute_inventory(root: pathlib.Path):
    """从真实源码计算目录清单与生产引用图。这是清单的唯一真源。"""
    src = source_files(root)
    prod = {p: strip_comments(t) for p, t in src.items() if is_production(p)}
    target_prefix = (SRC_ROOT / 'components/agent/presentation').as_posix() + '/'
    dir_files = sorted(
        p[len(target_prefix):] for p in src if p.startswith(target_prefix)
    )
    inventory = []
    for name in dir_files:
        ext = pathlib.Path(name).suffix
        stem = pathlib.Path(name).stem
        if name.endswith('.test.ts') or '__snapshots__' in name or name.endswith('.snap'):
            inventory.append({'name': name, 'kind': 'test', 'prod_refs': []})
            continue
        if ext not in ('.vue', '.ts'):
            inventory.append({'name': name, 'kind': 'other', 'prod_refs': []})
            continue
        pat = reference_pattern(stem, ext)
        self_path = target_prefix + name
        refs = sorted(
            p.replace('apps/web/src/', '')
            for p, text in prod.items()
            if p != self_path and pat.search(text)
        )
        inventory.append({
            'name': name,
            'kind': 'vue' if ext == '.vue' else 'module',
            'prod_refs': refs,
        })
    return inventory, src


def anchor_consumers(src: dict, stem: str):
    pat = reference_pattern(stem, '.vue')
    return sorted(
        p.replace('apps/web/src/', '')
        for p, t in src.items()
        if is_production(p) and pat.search(strip_comments(t))
    )


def within_ratchet(targets, inventory, src) -> bool:
    """删除棘轮：只允许删除「零生产引用、且不在保护名单」的真实孤儿。"""
    by_name = {it['name']: it for it in inventory}
    for t in targets:
        if t in SHARED_ANCHORS or t == GUARD_MOUNT:
            return False
        item = by_name.get(t)
        if item is None:
            return False
        if item['prod_refs']:
            return False
    return True


def function_body(code: str, name: str) -> str:
    m = re.search(r'def\s+' + re.escape(name) + r'\s*\(', code)
    if not m:
        return ''
    start = code.find('\n', m.end())
    if start < 0:
        return ''
    tail = code[start:]
    nxt = re.search(r'\n(?=def |GROUPS|if __name__|MANIFEST|GATE_CMD)', tail)
    return tail[:nxt.start()] if nxt else tail


def implementation_code(code: str) -> str:
    """剔除判据函数体，只留实现层，避免断言锚点自匹配造成恒绿。"""
    out = code
    for name in ['group_v1', 'group_v2', 'group_v3', 'group_v4',
                 'group_v5', 'group_v6', 'group_v7']:
        body = function_body(out, name)
        if body:
            out = out.replace(body, '', 1)
    return out


# --------------------------------------------------------------- 判据层 ----

def group_v1(impl, ctx):
    """V1 清单完整性：manifest 文件集合恰等于真实目录集合，全目录扫描无白名单。"""
    m = ctx['manifest']
    inv = ctx['inventory']
    names = [it['name'] for it in inv]
    listed = [it['name'] for it in m.get('inventory', [])]
    if not names or len(names) != ctx['dir_count']:
        return False, f"真实目录扫描不完整: inventory={len(names)} dir={ctx['dir_count']}"
    if sorted(set(listed)) != sorted(names) or len(listed) != len(names):
        return False, 'manifest 清单与真实目录不一致（漏登记或伪造）'
    return True, f'{len(names)} 个文件全登记'


def group_v2(impl, ctx):
    """V2 引用图一致：每个非测试文件的 prod_refs 恰等于真实计算值，且零孤儿。"""
    m = ctx['manifest']
    inv = ctx['inventory']
    listed = {it['name']: it for it in m.get('inventory', [])}
    for it in inv:
        if it['kind'] in ('test', 'other'):
            continue
        rec = listed.get(it['name'])
        if rec is None or sorted(rec.get('prod_refs', [])) != sorted(it['prod_refs']):
            return False, f"prod_refs 漂移: {it['name']}"
        if not it['prod_refs']:
            return False, f"存在孤儿: {it['name']}"
    return True, '引用图一致且零孤儿'


def group_v3(impl, ctx):
    """V3 删除棘轮：空集必须显式声明 NO_DELETE_TARGET，非空集必须逐项过 ratchet。"""
    m = ctx['manifest']
    targets = m.get('delete_targets', [])
    verdict = m.get('verdict')
    if not isinstance(targets, list):
        return False, 'delete_targets 非列表'
    if not targets and verdict != NO_DELETE:
        return False, '空集必须显式声明 NO_DELETE_TARGET'
    if targets and verdict == NO_DELETE:
        return False, '非空集不得声明 NO_DELETE_TARGET'
    # 行为级负向自检：空集时上面三条都走不到棘轮的拒绝分支，掏空
    # within_ratchet 会行为零变化（伪变异）。两条拒绝路径各配一个探针，
    # 且第二条用「人为清空引用」的合成清单，确保只有保护名单特判能拦住它
    # （真实保护对象都是活代码，否则下游零引用检查会替它兜住 ⇒ 假绿）。
    for probe, why in [
        (['AgentNodeGraph.vue'], '活代码'),
        (['NodeTileView.vue'], '共享层保护对象'),
    ]:
        if within_ratchet(probe, ctx['inventory'], ctx['src']):
            return False, f'棘轮负向自检失败：{why}探针未被拒绝'
    synthetic = [
        {**it, 'prod_refs': []} if it['name'] == 'NodeTileView.vue' else it
        for it in ctx['inventory']
    ]
    if within_ratchet(['NodeTileView.vue'], synthetic, ctx['src']):
        return False, '棘轮负向自检失败：零引用的保护对象未被拒绝'
    if not within_ratchet(targets, ctx['inventory'], ctx['src']):
        return False, '删除目标含活代码或保护对象'
    return True, f'删除目标 {len(targets)} 项 / {verdict}'


def group_v4(impl, ctx):
    """V4 保护对象：共享层双锚与护栏挂载点必须存在且被真实消费。"""
    m = ctx['manifest']
    prot = m.get('protected', {})
    if sorted(prot.get('shared_anchors', [])) != sorted(SHARED_ANCHORS):
        return False, '共享层双锚登记不符'
    if prot.get('guard_mount') != GUARD_MOUNT:
        return False, '护栏挂载点登记不符'
    for anchor in SHARED_ANCHORS:
        stem = pathlib.Path(anchor).stem
        consumers = anchor_consumers(ctx['src'], stem)
        if not any('/mobile/' in c for c in consumers):
            return False, f'{anchor} 无移动端薄壳消费'
    host = anchor_consumers(ctx['src'], pathlib.Path(GUARD_MOUNT).stem)
    if not any('AgentSideRail.vue' in c for c in host):
        return False, 'Host 未被 PC 侧栏消费'
    fixture = read(ctx['root'] / 'scripts/fixtures/pc-visual-page.html') or ''
    if pathlib.Path(GUARD_MOUNT).stem not in strip_comments(fixture):
        return False, '护栏 fixture 未挂载真实 Host'
    return True, '双锚与 Host 均有真实消费'


def group_v5(impl, ctx):
    """V5 只追加与死锁登记：母规格 §1–§15.7 字符级不变，§15.8 登记护栏互斥。"""
    spec = ctx['spec_text'] or ''
    raw = spec.encode('utf-8')
    prefix_len = ctx['manifest'].get('append_only_prefix_bytes', 0)
    if not prefix_len or len(raw) < prefix_len:
        return False, '母规格长度不足以承载只追加前缀'
    # 前缀长度是字节数；中文文档不能用字符切片，否则尾部恒空（只追加判据假红）
    prefix_sha = hashlib.sha256(raw[:prefix_len]).hexdigest()
    if prefix_sha != ctx['manifest'].get('append_only_prefix_sha256'):
        return False, '母规格历史段落被改写（违反只追加）'
    tail = raw[prefix_len:].decode('utf-8', errors='replace')
    if '15.8' not in tail:
        return False, '缺少 §15.8 状态回填'
    if '护栏' not in tail or '互斥' not in tail:
        return False, '§15.8 未登记护栏与删除刀互斥'
    rb = ctx['runbook_text'] or ''
    if 'pc-visual-baseline.json' not in rb or '四项' not in rb:
        return False, 'runbook 未保留删除刀准入契约'
    return True, '只追加前缀 sha256 相等 + §15.8 登记完备'


def group_v6(impl, ctx):
    """V6 写了必须挂：CI spec-figures job 内确有调用行（注释不算）。"""
    job = strip_yaml_comments(spec_figures_job(ctx['ci_text'] or ''))
    if 'verify-phase4-delete-scope.py' not in job:
        return False, 'spec-figures job 未挂载本判据'
    return True, 'CI 挂载有效'


def group_v7(impl, ctx):
    """V7 实现层自匹配防护：判据函数体剔除后，实现层必须仍有关键纯函数。"""
    for name in ['strip_comments', 'strip_yaml_comments', 'source_files',
                 'compute_inventory', 'within_ratchet', 'implementation_code']:
        if 'def ' + name not in impl:
            return False, f'实现层缺少 {name}'
    ratchet = function_body(impl, 'within_ratchet')
    if 'return False' not in ratchet or 'prod_refs' not in ratchet:
        return False, '棘轮方向实现疑似被掏空'
    comments = function_body(impl, 'strip_comments')
    if 're.sub' not in comments:
        return False, '注释剥离实现疑似被掏空'
    return True, '实现层判据齐备'


GROUPS = [
    ('V1', group_v1), ('V2', group_v2), ('V3', group_v3), ('V4', group_v4),
    ('V5', group_v5), ('V6', group_v6), ('V7', group_v7),
]


# --------------------------------------------------------------- 入口 ------

def build_manifest(root: pathlib.Path, spec_text: str) -> dict:
    inventory, _ = compute_inventory(root)
    prefix = spec_text.encode('utf-8')
    return {
        'schema': 'lnkpi.phase4-delete-scope.v1',
        'baseline_sha': '75f597c765a8cec5eca79a26911773d6ffa9d0a9',
        'baseline_source': 'gh api Git Data API true master tree; local parallel worktree NOT trusted',
        'target_dir': TARGET_DIR.as_posix(),
        'delete_targets': [],
        'verdict': NO_DELETE,
        'append_only_prefix_bytes': len(prefix),
        'append_only_prefix_sha256': hashlib.sha256(prefix).hexdigest(),
        'protected': {
            'shared_anchors': list(SHARED_ANCHORS),
            'guard_mount': GUARD_MOUNT,
            'reason': 'Phase 0-1 锚抬升后的共享层本体；② 护栏 fixture 挂载的真实组件链',
        },
        'inventory': inventory,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=str(REAL_ROOT), help='扫描根；变异测试可指向沙箱树')
    ap.add_argument('--emit-manifest', action='store_true', help='输出由真实源码计算的 manifest')
    ap.add_argument('--only', help='只跑指定组，如 V3')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    root = pathlib.Path(args.root).resolve()
    spec_text = read(root / MOTHER_SPEC) or ''
    inventory, src = compute_inventory(root)

    if args.emit_manifest:
        print(json.dumps(build_manifest(root, spec_text), ensure_ascii=False, indent=2))
        return 0

    mtext = read(root / MANIFEST)
    if mtext is None:
        print('FAIL  manifest 不存在: ' + MANIFEST.as_posix())
        print('VERDICT HAS_FAILURE V1,V2,V3,V4,V5,V6,V7')
        return 1
    try:
        manifest = json.loads(mtext)
    except json.JSONDecodeError as e:
        print(f'FAIL  manifest JSON 非法: {e}')
        return 1

    target_abs = root / TARGET_DIR
    dir_count = sum(
        1 for p in target_abs.rglob('*')
        if p.is_file() and (p.suffix in SOURCE_EXTS or p.name.endswith('.snap'))
    ) if target_abs.is_dir() else 0

    ctx = {
        'root': root,
        'manifest': manifest,
        'inventory': inventory,
        'src': src,
        'dir_count': dir_count,
        'spec_text': spec_text,
        'ci_text': read(root / CI),
        'runbook_text': read(root / RUNBOOK),
        'design_text': read(root / DESIGN),
    }
    impl = implementation_code(SELF.read_text(encoding='utf-8'))
    results = {}
    for name, fn in GROUPS:
        if args.only and name != args.only:
            continue
        ok, detail = fn(impl, ctx)
        results[name] = {'ok': ok, 'detail': detail}

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for name, r in results.items():
            print(f"{'PASS' if r['ok'] else 'FAIL'}  {name}  {r['detail']}")
        failed = [k for k, v in results.items() if not v['ok']]
        extra = ''
        if not failed and not manifest.get('delete_targets'):
            extra = ' ' + NO_DELETE
        print('VERDICT ' + ('ALL_PASS' if not failed else 'HAS_FAILURE ' + ','.join(failed)) + extra)
    return 0 if all(v['ok'] for v in results.values()) else 1


if __name__ == '__main__':
    sys.exit(main())
