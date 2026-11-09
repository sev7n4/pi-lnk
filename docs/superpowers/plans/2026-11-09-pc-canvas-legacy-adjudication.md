# PC 画布 legacy 合并裁决 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 用户已指定执行方式为 **Native**（本会话内逐任务实施，末尾一次全分支复核）。

**Goal:** 把「`components/canvas/` PC legacy 与移动端共享锚是否合并」裁决为 `NO_MERGE`，并用零依赖 verifier 把「零孤儿 ⇒ 无可删对象」锁成 CI 棘轮，母规格只追加收口。

**Architecture:** verifier 只读源码文本、manifest、CI 与规格文档，用 `apps/web/src` 全目录引用图计算四个 legacy 组件的生产引用，V1–V7 分组判据 + 合成探针防伪绿；manifest 由 verifier 从 true master 镜像计算产出而非手写；不改任何产品代码，故零行为变更、零生产发布。

**Tech Stack:** Python 3 标准库（`pathlib` / `re` / `hashlib` / `json`）、`gh api` Git Data API、GitHub Actions 既有 `spec-figures` job、Mermaid 内嵌规格图。

**Spec:** `docs/superpowers/specs/2026-11-09-pc-canvas-legacy-adjudication-design.md`

## Global Constraints

- 真值基线固定为 `d7c8246b2f9acd7a5f7d6431aec3523da2b358ce`；本地工作树 `AgentSideRail.vue` 与 master 裸 blob sha 不同，禁止采信。
- 零外部依赖：verifier 只 import Python 标准库；不起浏览器、不连网络、不解析 Vue AST。
- 零产品代码改动：`apps/**` / `package.json` / `deploy.yml` / `pc-visual-baseline.json` 全部零改动。
- `deploy.yml` 的 `push.paths` 含 `apps/web/**` 与 `package.json`，不含 `docs/` / `scripts/` / `ci.yml` ⇒ 本刀合并零生产发布。
- 母规格只追加：前缀 34217 字节 sha256 锁定，追加内容按**字节**切片再 decode，禁止字符切片。
- CI 只追加：`spec-figures` job 内追加一个 `- name` + `run` 步骤，不新建 job、不改 `package.json`。
- 冻结边界 `sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项零触碰；不按功能簇拆。
- 推送全走 `gh api` Git Data API；tree POST 必须用 `base_tree` 只传改动路径，禁带 4912 条全量条目（会 502）。
- 变异在 `/tmp` 沙箱树做，恢复后核裸 blob sha 全等；崩溃不算判据转红。

## Review Focus

1. **保护名单特判被掏空但探针恰是活代码**：`within_ratchet` 的零引用检查会替它兜住，行为零变化 ⇒ 合成探针（人为清空保护对象 `prod_refs`）必须精确 `V3` RED，任务 2 的 M10 覆盖。
2. **函数改名致 `NameError`**：`exit 1` 但无 FAIL 行，是崩溃不是判据转红 ⇒ 改名同时加别名，任务 5 的 M8 验证 V7 精确 RED。
3. **中文文档字符切片**：`spec[34217:]` 恒空 ⇒ 字节切片，任务 3 的 V5 与任务 5 的 M5 覆盖。
4. **YAML 注释伪装 CI 挂载**：`# python3 scripts/...` 不能判绿 ⇒ `strip_yaml_comments`，任务 5 的 M7 覆盖。
5. **基线在写作→推送间前移**：并行 PR 改同一路径 ⇒ `MASTER_MOVED_SAFE` 逐路径核对 + 按真实 parent 复核 `ALL_PARALLEL_KEPT`，任务 6 覆盖。

---

### Task 1: 从 true master 重建取证镜像并固化清单生成入口

**Files:**
- Create: `scripts/verify-pc-canvas-legacy-scope.py`（骨架 + `--emit-manifest`）
- Create: `scripts/fixtures/pc-canvas-legacy-manifest.json`（由脚本产出）
- Test: `scripts/fixtures/pc-canvas-legacy-manifest.json`

**Interfaces:**
- Consumes: `gh api repos/sev7n4/pi-lnk/git/trees/{MASTER}?recursive=1` 的 blob sha 映射；镜像 `/tmp/knives-master-full/apps/web/src` 逐文件裸 blob sha 校验，不匹配才回源 `git/blobs/{sha}`。
- Produces: `compute_inventory(root) -> (inventory: dict, src: dict)`；`emit_manifest(inventory) -> dict`，含 `baseline_sha` / `delete_targets` / `verdict` / `merge_decision` / `append_only_prefix_bytes` / `append_only_prefix_sha256` / `protected` / `inventory`。

- [ ] **Step 1: 写清单生成的失败测试**

```python
# /tmp/knife23_probe.py 已产出真值：四个 legacy 组件各 3 处生产引用
# （CanvasReadonlyPage / ReplayPage / NodeRenderer），逐项核对：
assert set(inventory) == {
    'CanvasNodeImage.vue','CanvasNodeVideo.vue','CanvasNodeAudio.vue','CanvasNodeText.vue',
    'NodeRenderer.vue','MobileNodeTile.vue','NodeTileView.vue',
    'CanvasPage.vue','CanvasReadonlyPage.vue','ReplayPage.vue',
}
assert all(inventory[n]['prod_refs'] >= 2 for n in LEGACY_NAMES)
```

- [ ] **Step 2: 跑一次确认当前无脚本，测试失败**

Run: `python3 scripts/verify-pc-canvas-legacy-scope.py --emit-manifest --root /tmp/knives-master-full`
Expected: `FileNotFoundError`（脚本尚不存在）。

- [ ] **Step 3: 实现 `strip_comments` / `reference_pattern` / `compute_inventory` / `emit_manifest`**

```python
LEGACY_NAMES = ('CanvasNodeImage.vue','CanvasNodeVideo.vue','CanvasNodeAudio.vue','CanvasNodeText.vue')
def compute_inventory(root):
    src, inv = {}, {}
    for p in pathlib.Path(root, 'apps/web/src').rglob('*'):
        if p.is_file() and p.suffix in ('.vue','.ts','.tsx','.js','.mjs'):
            txt = strip_comments(p.read_text(errors='replace'))
            src[str(p)] = txt
    for name, rel in INVENTORY_PATHS.items():
        stem = pathlib.Path(name).stem
        refs = [k for k,v in src.items()
                if name not in k and '.test.' not in k
                and re.search(reference_pattern(stem), v)]
        inv[name] = {'kind':'vue','prod_refs':len(refs),'lines':LINE_COUNT[rel]}
    return inv, src
```

- [ ] **Step 4: 生成 manifest 并核对**

Run: `python3 scripts/verify-pc-canvas-legacy-scope.py --emit-manifest --root /tmp/knives-master-full`
Expected: 写出 `scripts/fixtures/pc-canvas-legacy-manifest.json`，`delete_targets: []`、`verdict: NO_DELETE_TARGET`、`merge_decision.decision: NO_MERGE`、四个组件 `prod_refs` 恰为 3。

- [ ] **Step 5: 记录基线常量**

把母规格当前字节数 34217 与 `sha256(raw[:34217])` 写进 manifest 的 `append_only_prefix_bytes` / `append_only_prefix_sha256`；提交描述注明来源为 `wc -c` + `sha256sum`。

---

### Task 2: 实现 V1–V7 分组判据（含合成探针与判据自匹配防护）

**Files:**
- Modify: `scripts/verify-pc-canvas-legacy-scope.py`
- Test: `python3 scripts/verify-pc-canvas-legacy-scope.py --only V3`

**Interfaces:**
- Consumes: Task 1 的 `compute_inventory` / `emit_manifest`。
- Produces: `within_ratchet(targets, inventory) -> bool`；`implementation_code(code) -> str`；`GROUPS` 字典；`--json` / `--only` CLI；`VERDICT ALL_PASS NO_MERGE_NO_DELETE_TARGET`。

- [ ] **Step 1: 写 V3 合成探针的失败测试**

```python
# 合成探针：保护对象引用清空后列入 delete_targets
# 只有保护名单分支能拒绝它；零引用分支会放行 ⇒ 判据必须 RED
probe_inv = {k: dict(v) for k,v in inv.items()}
probe_inv['CanvasNodeImage.vue']['prod_refs'] = 0
assert within_ratchet([{'name':'CanvasNodeImage.vue'}], probe_inv) is False
```

- [ ] **Step 2: 跑一次确认失败**

Run: `python3 scripts/verify-pc-canvas-legacy-scope.py --only V3`
Expected: FAIL `V3`（`within_ratchet` 尚未实现）。

- [ ] **Step 3: 实现七组判据**

| 组 | 判据 |
| --- | --- |
| V1 | manifest 条目集合 == 真实目录集合；`kind` / `lines` 合法 |
| V2 | 每个 legacy 组件 `prod_refs` 逐项等于真实计算值且 ≥ 2 |
| V3 | `delete_targets == []`、`verdict == NO_DELETE_TARGET`、合成探针被 `within_ratchet` 拒绝 |
| V4 | `merge_decision.decision == NO_MERGE`、`reasons` 恰 4 条；`NodeRenderer.vue` 含分派形态；`NodeTileView` 仍被 `MobileNodeTile` 消费 |
| V5 | 母规格 `raw[:34217]` sha256 相等；`raw[34217:].decode()` 含 `NO_MERGE` 与 `DELETE_ACTION_CLOSED_NO_TARGET`；② 的 `pc-visual-baseline.json` 与四项准入文本在位 |
| V6 | `strip_yaml_comments(ci.yml)` 的 `spec-figures` job 段含调用行 |
| V7 | `implementation_code(code)` 含 6 个实现层纯函数定义 |

- [ ] **Step 4: 全量跑绿**

Run: `python3 scripts/verify-pc-canvas-legacy-scope.py`
Expected: `VERDICT ALL_PASS NO_MERGE_NO_DELETE_TARGET`，`exit 0`。

- [ ] **Step 5: 断言自匹配防护有效**

Run: `python3 -c "import ast,pathlib;print('group_v' in ast.parse(pathlib.Path('scripts/verify-pc-canvas-legacy-scope.py').read_text()).__repr__())"`
Expected: 判据函数体内的锚点字面量不出现在 `implementation_code()` 输出中。

---

### Task 3: CI 挂载 + 母规格 §15.9 只追加

**Files:**
- Modify: `.github/workflows/ci.yml`（只追加 2 行）
- Modify: `docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md`（只追加 §15.9）

**Interfaces:**
- Consumes: Task 2 的 V5/V6 期望字符串。
- Produces: CI 步骤名 `Verify pc canvas legacy scope (NO_MERGE ratchet)`；母规格 §15.9 段。

- [ ] **Step 1: 追加 CI 步骤**

```yaml
      - name: Verify pc canvas legacy scope (NO_MERGE ratchet)
        run: python3 scripts/verify-pc-canvas-legacy-scope.py
```

插入位置：既有 `Verify phase4 delete scope` 步骤之后、`spec-figures` job 内；不改既有行。

- [ ] **Step 2: 写 §15.9（中文按字节只追加）**

```python
p = pathlib.Path(spec_path)
raw = p.read_bytes()
assert len(raw) == 34217 and hashlib.sha256(raw).hexdigest() == PREFIX_SHA
p.write_bytes(raw + SECTION_15_9.encode('utf-8'))
```

§15.9 内容必须含：`NO_MERGE` 四条理由摘要、`DELETE_ACTION_CLOSED_NO_TARGET`、`components/canvas/` 侧行为级准入契约指向 runbook §7、诚实边界（不宣称 Phase 4 功能闭环）。

- [ ] **Step 3: 验证只追加**

Run: `python3 - <<'PY'` 比对 `raw[:34217]` sha256 与追加前一致。
Expected: `append_only True`。

---

### Task 4: runbook 与证据文档

**Files:**
- Create: `docs/ops/2026-11-09-pc-canvas-legacy-scope-runbook.md`
- Create: `docs/ops/2026-11-09-pc-canvas-legacy-scope-evidence.md`

**Interfaces:**
- Consumes: Task 1 取证数据、Task 2 判据表、Task 5 变异结果。
- Produces: runbook §7「`components/canvas/` 侧行为级准入契约」（若将来重启合并，须附 PC 画布节点渲染形态 CDP 冒烟取证 + 契约测试 + 两端截图，且不得改 `pc-visual-baseline.json`）。

- [ ] **Step 1: 写 runbook**（§1 锁什么 / §2 判据表 / §3 运行 / §4 三条坑 / §5 变异 / §6 诚实边界 / §7 行为级准入契约）

- [ ] **Step 2: 写证据文档**（取证数字、V1–V7 输出、变异矩阵、CI run id、诚实边界）

- [ ] **Step 3: 跑规格门禁**

Run: `pnpm verify-spec-figures` 与 `pnpm verify-spec-figures --file <本规格路径>`。
Expected: 本规格 0 error；全量 0 error、既有历史 warning 不归因本刀。

---

### Task 5: 变异测试 ≥ 10 组（沙箱，恢复后核裸 blob sha）

**Files:**
- Test: `/tmp/knife23-mutation.py`（临时脚本，不入库）

**Interfaces:**
- Consumes: `/tmp/knives-master-full` 镜像、`--root` 沙箱模式。
- Produces: `M1..M12` 结果矩阵 + 恢复后裸 blob sha 全等断言。

- [ ] **Step 1: 写 12 组变异**

| 组 | 变异 | 期望 |
| --- | --- | --- |
| M1 | manifest 漏登记一个组件 | `V1` RED |
| M2 | 把某组件 `prod_refs` 改成 0 | `V2` RED |
| M3 | `delete_targets` 塞入活跃组件 | `V3` RED |
| M4 | `merge_decision` 改成 `MERGE` | `V4` RED |
| M5 | 删母规格 §15.9 追加段 | `V5` RED |
| M6 | 删 CI 挂载 | `V6` RED |
| M7 | CI 挂载只写进 YAML 注释 | `V6` RED |
| M8 | 实现层函数改名并加别名 | `V7` RED |
| M9 | 真实删除 `CanvasNodeImage.vue` | `V1`/`V2` RED |
| M10 | 合成探针：清空保护对象引用后标可删 | `V3` RED |
| M11 | 组件名只写进注释 | 全绿（不误报） |
| M12 | 无关注释追加 | 全绿（对照） |

- [ ] **Step 2: 执行并逐组核对**

Run: `python3 /tmp/knife23-mutation.py`
Expected: 12/12 符合期望；任一不符先怀疑伪变异，不得当成通过。

- [ ] **Step 3: 恢复校验**

Run: `sha1("blob %d\0"+data)` 逐文件比对 8 个交付路径。
Expected: `ALL_LOCAL_MATCH True`。

---

### Task 6: 推 PR / CI / squash / 合并树核对 / 状态回填

**Files:**
- Modify: `Issue #755`（只追加）、`.workbuddy/memory/2026-11-09.md`、`.workbuddy/memory/MEMORY.md`

**Interfaces:**
- Consumes: 8 个交付路径的工作树裸 blob sha、master 真实 tree。
- Produces: PR、合并 commit、生产只读复核、Issue 与记忆回填。

- [ ] **Step 1: 推前逐路径核对 + `MASTER_MOVED_SAFE`**

对每个交付路径算裸 blob sha，与 master 同路径比对：新增路径必须不在 master，已改路径（母规格 / ci.yml）必须等于「master 内容 + 只追加段」；若 master 前移且涉及这些路径，重新取回并重算，不追溯改写结论。

- [ ] **Step 2: REST 三段推送**

`git/blobs`（按内容 sha 幂等，502 有限重试）→ `git/trees` 用 `base_tree` **只传 8 个改动路径** → `git/commits` → `git/refs` → PR。PR body 用 `@文件` 会静默丢内容 ⇒ 必须回读 `body_len`。

- [ ] **Step 3: 等 CI 三必需**

Run: `gh api repos/sev7n4/pi-lnk/actions/runs?head_sha=<sha>` 轮询至 completed，逐 job 核 `Build monorepo` / `Verify spec figures` / `Build API Docker image` 全 success，并确认新增步骤在 CI 自举通过。

- [ ] **Step 4: squash 合并 + 合并树全量核对**

按**合并瞬间真实 parent**核对（GitHub squash 的 parent 是合并时 HEAD，不是脚本里读的 `before`）；差异恰 8 路径、`ALL_LOCAL_MATCH True`、`NO_OTHER True`、`ALL_PARALLEL_KEPT True`。

- [ ] **Step 5: 零发布 + 生产只读复核 + 回填**

核 `deploy.yml` 最近 runs 不含本次 merge sha；SSH `deploy-cvm` 复核 health/web 200；Issue #755 只追加回填（`append_only True`）；两份记忆只追加登记 `NO_MERGE` 与「删除动作终止 ≠ 功能闭环」。

---

## Self-Review

1. **Spec coverage**：§1 三目标 → Task 1/2/3；§2 不做清单 → Global Constraints + Task 6 推前核对；§4 判据 A–G → Task 1/2/3/5；§5 图 1 与四条理由 → 规格本体 + V4；§6 S1–S7 → Task 2；§9 八路径 → Task 1/2/3/4/6；§10 验收 → Task 3/5/6；§11 R1–R8 → Review Focus 与 Task 5/6；§12 后续 → 规格本体。无缺口。
2. **Placeholder scan**：无 TBD / TODO /「适当处理」；每个代码步骤给出可运行片段或精确命令。
3. **Type consistency**：`compute_inventory` / `within_ratchet` / `implementation_code` / `emit_manifest` 在 Task 1–2 定义、Task 2–5 引用，名称一致；`append_only_prefix_bytes=34217` 全文一致。
4. **Review Focus**：五条均有对应任务测试（M10 / M8 / M5 / M7 / Task 6 Step 1+4）。
