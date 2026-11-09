#!/usr/bin/env python3
"""PC 画布 legacy 合并裁决棘轮判据（路线 ② 第二刀）。

定位：回答母规格 §15.8 留下的架构问题「components/canvas/ 的 PC legacy
分支与移动端共享锚是否合并」，结论 NO_MERGE；并把「四个 legacy 组件零孤儿
⇒ 无可删对象」从主观判断变成可机检、可失败、确定性的工程契约。

零外部依赖（Python 标准库）；只读源码文本、manifest、CI 与规格文档；
不解析 Vue、不起浏览器、不连网络。真值纪律：清单来自 true master 源码，
不采信本地并行工作树（实测 AgentSideRail.vue 裸 blob sha 与 master 不同）。
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

SRC_ROOT = pathlib.Path('apps/web/src')
MANIFEST = pathlib.Path('scripts/fixtures/pc-canvas-legacy-manifest.json')
MOTHER_SPEC = pathlib.Path('docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md')
CI = pathlib.Path('.github/workflows/ci.yml')
RUNBOOK = pathlib.Path('docs/ops/2026-11-09-pc-canvas-legacy-scope-runbook.md')
PC_VISUAL_RUNBOOK = pathlib.Path('docs/ops/2026-11-09-pc-visual-regression-runbook.md')
PC_VISUAL_BASELINE = pathlib.Path('scripts/baselines/pc-visual-baseline.json')
DESIGN = pathlib.Path('docs/superpowers/specs/2026-11-09-pc-canvas-legacy-adjudication-design.md')

GATE_CMD = 'python3 scripts/verify-pc-canvas-legacy-scope.py'
BASELINE_SHA = 'd7c8246b2f9acd7a5f7d6431aec3523da2b358ce'
NO_DELETE = 'NO_DELETE_TARGET'
NO_MERGE = 'NO_MERGE'
SOURCE_EXTS = ('.vue', '.ts', '.tsx', '.js')

REL = {
    'CanvasNodeImage.vue': 'apps/web/src/components/canvas/CanvasNodeImage.vue',
    'CanvasNodeVideo.vue': 'apps/web/src/components/canvas/CanvasNodeVideo.vue',
    'CanvasNodeAudio.vue': 'apps/web/src/components/canvas/CanvasNodeAudio.vue',
    'CanvasNodeText.vue': 'apps/web/src/components/canvas/CanvasNodeText.vue',
    'NodeRenderer.vue': 'apps/web/src/components/canvas/NodeRenderer.vue',
    'MobileNodeTile.vue': 'apps/web/src/components/mobile/MobileNodeTile.vue',
    'NodeTileView.vue': 'apps/web/src/components/agent/presentation/NodeTileView.vue',
    'CanvasPage.vue': 'apps/web/src/pages/CanvasPage.vue',
    'CanvasReadonlyPage.vue': 'apps/web/src/pages/CanvasReadonlyPage.vue',
    'ReplayPage.vue': 'apps/web/src/pages/ReplayPage.vue',
}
LEGACY_NAMES = (
    'CanvasNodeImage.vue', 'CanvasNodeVideo.vue',
    'CanvasNodeAudio.vue', 'CanvasNodeText.vue',
)
PROTECTED = (
    'CanvasNodeImage.vue', 'CanvasNodeVideo.vue',
    'CanvasNodeAudio.vue', 'CanvasNodeText.vue',
    'NodeRenderer.vue', 'MobileNodeTile.vue', 'NodeTileView.vue',
)
CONSUMERS = ('CanvasPage.vue', 'CanvasReadonlyPage.vue', 'ReplayPage.vue')
MERGE_REASONS = (
    'CanvasReadonlyPage 与 ReplayPage 的 nodeTypes 固定 PC 形态，删除会破坏只读页与回放页',
    'NodeTileView 1419 行是移动端锚，含 tap 长按 选择 提示词审核策略，PC 画布形态不同',
    '母规格 L5 外壳各端自理是既定边界，强合并回退锚抬升成果且违反不按功能簇拆',
    'NodeRenderer 的 isMobileLayout 分派是活跃分支，运行时同时服务两端无可下线半边',
)
REASON_ANCHORS = (
    ('CanvasReadonlyPage', 'ReplayPage'),
    ('NodeTileView', '1419'),
    ('L5', '各端自理'),
    ('isMobileLayout', '活跃'),
)
DISPATCH_RE = re.compile(
    r'isMobileLayout\.value\s*\?\s*MobileNodeTile\s*:\s*\(?legacy\['
)


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
        if re.match(r'^(\s*)//', line):
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
        if p.is_file() and p.suffix in SOURCE_EXTS:
            result[p.relative_to(root).as_posix()] = read(p)
    return {k: v for k, v in result.items() if v is not None}


def is_production(path: str) -> bool:
    return '.test.' not in path and '__snapshots__' not in path and not path.endswith('.snap')


def reference_pattern(stem: str) -> re.Pattern:
    return re.compile(r'(?<![\w])' + re.escape(stem) + r'(?![\w])')


def compute_inventory(root: pathlib.Path):
    """从真实源码计算 10 个目标条目的生产引用图与行数。清单的唯一真源。"""
    src = source_files(root)
    prod = {p: strip_comments(t) for p, t in src.items() if is_production(p)}
    inventory = []
    for name, rel in REL.items():
        stem = pathlib.Path(name).stem
        pat = reference_pattern(stem)
        refs = sorted(
            p.replace('apps/web/src/', '')
            for p, text in prod.items()
            if p != rel and pat.search(text)
        )
        text = src.get(rel)
        inventory.append({
            'name': name,
            'kind': 'page' if name in CONSUMERS else 'vue',
            'prod_refs': refs,
            'lines': len(text.splitlines()) if text is not None else 0,
        })
    return inventory, src


def discover_legacy(src: dict):
    """动态发现：components/canvas/ 下被 NodeRenderer 的 legacy 分派引用的 CanvasNode*.vue。

    防「手写清单漏登记」伪绿；不是扫固定常量，而是从真实分派源码反推。
    只以 NodeRenderer 为发现源：只读页还会额外引用 Group / Prompt 等节点组件，
    它们不参与 legacy 分派，纳入会让集合恒不等于四个 legacy。
    """
    renderer = strip_comments(src.get(REL['NodeRenderer.vue'], '') or '')
    found = set()
    for rel in src:
        m = re.match(r'.*/components/canvas/(CanvasNode\w+)\.vue$', rel)
        if not m:
            continue
        stem = m.group(1)
        if reference_pattern(stem).search(renderer):
            found.add(stem + '.vue')
    return found


def within_ratchet(targets, inventory) -> bool:
    """删除棘轮：只允许删「在清单内、零生产引用、且不在保护名单」的真实孤儿。"""
    by_name = {it['name']: it for it in inventory}
    for t in targets:
        if t in PROTECTED:
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
    """V1 清单完整性：manifest 恰登记 10 个真实存在的条目，且动态发现的 legacy 全在清单。"""
    listed = [it['name'] for it in ctx['manifest'].get('inventory', [])]
    if sorted(set(listed)) != sorted(REL) or len(listed) != len(REL):
        return False, 'manifest 清单与真实目标集合不一致（漏登记或伪造）'
    for name, rel in REL.items():
        if not (ctx['root'] / rel).is_file():
            return False, f'目标文件缺失: {name}'
    discovered = discover_legacy(ctx['src'])
    if discovered != set(LEGACY_NAMES):
        return False, f'动态发现的 legacy 与清单不符: {sorted(discovered)}'
    if not all(it.get('lines', 0) > 0 for it in ctx['inventory']):
        return False, '存在空文件或行数计算失败'
    return True, f'{len(REL)} 个条目全登记，动态发现 {len(discovered)} 个 legacy'


def group_v2(impl, ctx):
    """V2 引用图一致：逐项 prod_refs / lines 等于真实计算值，四个 legacy 零孤儿。"""
    listed = {it['name']: it for it in ctx['manifest'].get('inventory', [])}
    for it in ctx['inventory']:
        rec = listed.get(it['name'])
        if rec is None:
            return False, f'清单缺项: {it["name"]}'
        if sorted(rec.get('prod_refs', [])) != sorted(it['prod_refs']):
            return False, f'prod_refs 漂移: {it["name"]}'
        if rec.get('lines') != it['lines']:
            return False, f'行数漂移: {it["name"]}'
    for it in ctx['inventory']:
        if it['name'] in LEGACY_NAMES and len(it['prod_refs']) < 2:
            return False, f'legacy 组件生产引用不足 2: {it["name"]}'
    return True, '引用图一致且四个 legacy 均有多处生产引用'


def group_v3(impl, ctx):
    """V3 删除棘轮：空集显式 NO_DELETE_TARGET；三条拒绝路径各配合成探针。"""
    m = ctx['manifest']
    targets = m.get('delete_targets', [])
    verdict = m.get('verdict')
    if not isinstance(targets, list):
        return False, 'delete_targets 非列表'
    if not targets and verdict != NO_DELETE:
        return False, '空集必须显式声明 NO_DELETE_TARGET'
    if targets and verdict == NO_DELETE:
        return False, '非空集不得声明 NO_DELETE_TARGET'
    inv = ctx['inventory']
    # 探针 1：活代码（零引用分支应拒绝）
    for probe in ('CanvasNodeImage.vue', 'NodeTileView.vue'):
        if within_ratchet([probe], inv):
            return False, f'棘轮负向自检失败：活代码 {probe} 未被拒绝'
    # 探针 2（合成）：人为清空保护对象的引用，使只有保护名单分支能拦住它。
    # 真实保护对象都是活代码，否则下游零引用检查会替它兜住 ⇒ 假绿。
    synthetic = [
        {**it, 'prod_refs': []} if it['name'] == 'NodeTileView.vue' else it
        for it in inv
    ]
    if within_ratchet(['NodeTileView.vue'], synthetic):
        return False, '棘轮负向自检失败：零引用的保护对象未被拒绝'
    # 探针 3（方向对照）：非保护、零引用的合成孤儿应放行，证明棘轮不是恒 False。
    ghost = list(synthetic) + [{'name': 'Ghost.vue', 'kind': 'vue', 'prod_refs': [], 'lines': 1}]
    if not within_ratchet(['Ghost.vue'], ghost):
        return False, '棘轮方向异常：零引用非保护孤儿被拒绝'
    if not within_ratchet(targets, inv):
        return False, '删除目标含活代码或保护对象'
    return True, f'删除目标 {len(targets)} 项 / {verdict}'


def group_v4(impl, ctx):
    """V4 合并裁决：NO_MERGE 四条理由齐备；分派点与薄壳链登记在位。"""
    m = ctx['manifest']
    md = m.get('merge_decision', {})
    if md.get('decision') != NO_MERGE:
        return False, '合并裁决不是 NO_MERGE'
    reasons = md.get('reasons', [])
    if len(reasons) != len(MERGE_REASONS):
        return False, f'裁决理由应为 4 条，实为 {len(reasons)}'
    for reason, anchors in zip(reasons, REASON_ANCHORS):
        if not all(a in reason for a in anchors):
            return False, f'裁决理由缺锚点 {anchors}'
    renderer = read(ctx['root'] / REL['NodeRenderer.vue']) or ''
    if not DISPATCH_RE.search(strip_comments(renderer)):
        return False, 'NodeRenderer 唯一布局分派形态未登记或被改写'
    tile = read(ctx['root'] / REL['MobileNodeTile.vue']) or ''
    if not reference_pattern('NodeTileView').search(strip_comments(tile)):
        return False, 'MobileNodeTile 未消费 NodeTileView 薄壳锚'
    readonly = strip_comments(read(ctx['root'] / REL['CanvasReadonlyPage.vue']) or '')
    replay = strip_comments(read(ctx['root'] / REL['ReplayPage.vue']) or '')
    canvas = strip_comments(read(ctx['root'] / REL['CanvasPage.vue']) or '')
    if not all(reference_pattern(pathlib.Path(n).stem).search(readonly) for n in LEGACY_NAMES):
        return False, 'CanvasReadonlyPage 的 4 条 legacy 引用链不完整'
    if not all(reference_pattern(pathlib.Path(n).stem).search(replay)
               for n in ('CanvasNodeImage.vue', 'CanvasNodeVideo.vue', 'CanvasNodeText.vue')):
        return False, 'ReplayPage 的 3 条 legacy 引用链不完整'
    if not reference_pattern('NodeRenderer').search(canvas):
        return False, 'CanvasPage 未消费 NodeRenderer 分派点'
    return True, 'NO_MERGE 四理由齐备，只读页 / 回放页 / 画布页分派链在位'


def group_v5(impl, ctx):
    """V5 只追加与护栏只读：母规格 §1–§15.8 字节级不变，§15.9 登记裁决。"""
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
    if '15.9' not in tail:
        return False, '缺少 §15.9 状态回填'
    if NO_MERGE not in tail or 'DELETE_ACTION_CLOSED_NO_TARGET' not in tail:
        return False, '§15.9 未登记裁决与删除动作终止'
    if '功能闭环' not in tail:
        return False, '§15.9 未显式声明「不宣称功能闭环」诚实边界'
    rb = ctx['pc_visual_runbook_text'] or ''
    for token in ('VERDICT ALL_PASS', 'diff_count=0', 'SHA_A', 'PNG', '删除刀准入契约'):
        if token not in rb:
            return False, f'② 准入契约被改写或缺项: {token}'
    if not (ctx['root'] / PC_VISUAL_BASELINE).is_file():
        return False, 'pc-visual-baseline.json 缺失'
    own_rb = ctx['runbook_text'] or ''
    if '行为级准入' not in own_rb or 'components/canvas/' not in own_rb:
        return False, '本刀 runbook 未补该侧行为级准入契约'
    return True, '只追加前缀 sha256 相等 + §15.9 登记完备 + ② 护栏只读'


def group_v6(impl, ctx):
    """V6 写了必须挂：CI spec-figures job 内确有调用行（注释不算）。"""
    job = strip_yaml_comments(spec_figures_job(ctx['ci_text'] or ''))
    if 'verify-pc-canvas-legacy-scope.py' not in job:
        return False, 'spec-figures job 未挂载本判据'
    return True, 'CI 挂载有效'


def group_v7(impl, ctx):
    """V7 实现层自匹配防护：判据函数体剔除后，实现层必须仍有关键纯函数。"""
    for name in ['strip_comments', 'strip_yaml_comments', 'source_files',
                 'compute_inventory', 'discover_legacy', 'within_ratchet']:
        if 'def ' + name not in impl:
            return False, f'实现层缺少 {name}'
    ratchet = function_body(impl, 'within_ratchet')
    if 'return False' not in ratchet or 'prod_refs' not in ratchet:
        return False, '棘轮方向实现疑似被掏空'
    comments = function_body(impl, 'strip_comments')
    if 're.sub' not in comments:
        return False, '注释剥离实现疑似被掏空'
    discover = function_body(impl, 'discover_legacy')
    if 'reference_pattern' not in discover:
        return False, '动态发现实现疑似被掏空'
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
        'schema': 'lnkpi.pc-canvas-legacy-scope.v1',
        'baseline_sha': BASELINE_SHA,
        'baseline_source': 'gh api Git Data API true master tree; local parallel worktree NOT trusted',
        'target_scope': 'apps/web/src/components/canvas + mobile + agent/presentation anchors',
        'delete_targets': [],
        'verdict': NO_DELETE,
        'merge_decision': {
            'decision': NO_MERGE,
            'reasons': list(MERGE_REASONS),
            'adjudicated_at': '2026-11-09',
            'source': 'true master 源码引用图 + 母规格 §3 L5 外壳各端自理',
        },
        'append_only_prefix_bytes': len(prefix),
        'append_only_prefix_sha256': hashlib.sha256(prefix).hexdigest(),
        'protected': {
            'list': list(PROTECTED),
            'reason': '四个 legacy 组件被只读页链与回放页链活跃引用；NodeRenderer 是唯一布局分派点；MobileNodeTile 与 NodeTileView 是移动端共享锚链',
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

    ctx = {
        'root': root,
        'manifest': manifest,
        'inventory': inventory,
        'src': src,
        'spec_text': spec_text,
        'ci_text': read(root / CI),
        'runbook_text': read(root / RUNBOOK),
        'pc_visual_runbook_text': read(root / PC_VISUAL_RUNBOOK),
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
            extra = ' ' + NO_MERGE + '_' + NO_DELETE
        print('VERDICT ' + ('ALL_PASS' if not failed else 'HAS_FAILURE ' + ','.join(failed)) + extra)
    return 0 if all(v['ok'] for v in results.values()) else 1


if __name__ == '__main__':
    sys.exit(main())
