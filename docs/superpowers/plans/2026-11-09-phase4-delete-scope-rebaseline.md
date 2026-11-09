# Phase 4 删除域重界定 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, 用户已指定) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把母规格 §9「删 `presentation/` 下 PC 冗余渲染」的删除对象，从过期的主观行数描述变成可机检棘轮，并只追加回填母规格 §15.8，零产品代码改动。

**Architecture:** 一个 Python 标准库 verifier 读真实源码计算 `presentation/` 全目录引用图 → 与 manifest 双向比对（集合 + 引用图）→ V1–V7 七个判据组，空集显式 `NO_DELETE_TARGET`；挂到既有 `spec-figures` job 内一步。母规格历史段落由字节级前缀 sha256 锁定，只追加 §15.8。

**Tech Stack:** Python 3 标准库（`pathlib` / `re` / `hashlib` / `json` / `argparse`）；GitHub Actions 既有 `spec-figures` job；`gh api` Git Data API 推送链。

**Spec:** `docs/superpowers/specs/2026-11-09-phase4-delete-scope-rebaseline-design.md`

## Global Constraints

- 真值基线：`gh api` true master `75f597c765a8cec5eca79a26911773d6ffa9d0a9`；本地并行工作树 951 源文件中 7 个裸 blob sha 不同，**不采信**。
- 零行为变更：不改 `apps/web/**` 任何文件；本刀只加脚本、manifest、CI 一步、文档。
- 不碰冻结边界：`sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项；不按功能簇拆。
- 只追加：母规格 §1–§15.7 零删除改写；`ci.yml` 只加 2 行到既有 job，不新建 job；**不改 `package.json`**（`deploy.yml` 的 `push.paths` 含它）。
- 零生产发布：`deploy.yml` 的 `push.paths` 不含 `docs/` / `scripts/` / `ci.yml`。
- CI 三必需：`Verify spec figures` / `Build monorepo` / `Build API Docker image`。
- 删除刀准入契约（runbook §7）四项凭据与 `pc-visual-baseline.json` 只读约束**原样保留**，不放宽。
- 历史时点结论不追溯改写，只做只追加状态回填；不宣告未闭环项 `ALL_PASS`。

## Review Focus

1. **清单漏登记一个真实文件** → V1 应 RED（全目录扫描，无白名单；含 `__snapshots__/*.snap`）。
2. **伪造 `prod_refs` 让活代码看起来可删** → V2 应 RED（逐项等于真实计算值）。
3. **把 `NodeTileView.vue` 放进 `delete_targets`** → V3 + V4 应 RED（保护名单 + 移动端薄壳消费）。
4. **把锚点只写进注释** → 对照绿，不得误 RED（`strip_comments` / `strip_yaml_comments`）。
5. **改写母规格 §2 一个字** → V5 应 RED（字节级前缀 sha256）。

---

### Task 1: true master 取证与 verifier RED

**Files:**
- Create: `scripts/verify-phase4-delete-scope.py`

**Interfaces:**
- Produces: `compute_inventory(root) -> (inventory, src)`；`within_ratchet(targets, inventory, src) -> bool`；`implementation_code(code) -> str`；`group_v1..v7`；CLI `--root` / `--emit-manifest` / `--only` / `--json`

- [ ] **Step 1: 用 `gh api` 取 true master 树，构建镜像沙箱**

```bash
gh api repos/sev7n4/pi-lnk/git/trees/75f597c765a8cec5eca79a26911773d6ffa9d0a9?recursive=1 \
  --jq '.tree[] | select(.type=="blob") | .path+"\t"+.sha' > /tmp/tree.tsv
# 逐文件：本地裸 blob sha 相等则 copy，否则 gh api .../git/blobs/{sha} 解码落盘
```

预期：`apps/web/src` 951 个源文件中 944 个全等、7 个从 master 取回；`presentation/` 27 个 blob。

- [ ] **Step 2: 写 verifier 的判据组（先让 V1–V7 对空 manifest 全红）**

```python
GROUPS = [
    ('V1', group_v1), ('V2', group_v2), ('V3', group_v3), ('V4', group_v4),
    ('V5', group_v5), ('V6', group_v6), ('V7', group_v7),
]
```

- [ ] **Step 3: 运行，确认 RED**

```bash
python3 scripts/verify-phase4-delete-scope.py --root /tmp/knives-master-full
```

预期：`FAIL  manifest 不存在`、`VERDICT HAS_FAILURE V1,V2,V3,V4,V5,V6,V7`、`exit 1`。

---

### Task 2: 由真实源码产出 manifest，追加 §15.8 与 CI 一步

**Files:**
- Create: `scripts/fixtures/phase4-delete-scope-manifest.json`
- Modify: `docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md`（只追加 §15.8）
- Modify: `.github/workflows/ci.yml`（`spec-figures` job 追加 2 行）
- Create: `docs/ops/2026-11-09-phase4-delete-scope-runbook.md`
- Create: `docs/superpowers/specs/2026-11-09-phase4-delete-scope-rebaseline-design.md`

**Interfaces:**
- Consumes: Task 1 的 `compute_inventory` / `build_manifest`
- Produces: `phase4-delete-scope-manifest.json`（`verdict: NO_DELETE_TARGET`、27 条 inventory、字节级前缀 sha256）

- [ ] **Step 1: 在镜像沙箱上生成清单（禁止手写）**

```bash
python3 scripts/verify-phase4-delete-scope.py --root /tmp/knives-master-full --emit-manifest \
  > scripts/fixtures/phase4-delete-scope-manifest.json
```

预期：`inventory=27`、`delete_targets=[]`、`verdict=NO_DELETE_TARGET`、`append_only_prefix_bytes=30150`。

- [ ] **Step 2: 母规格只追加 §15.8**

```python
old = p.read_bytes(); assert len(old) == 30150
new = old + addition.encode('utf-8')
assert new[:len(old)] == old
p.write_bytes(new)
```

预期：`pre=30150` → `post=34217`，前缀 sha256 不变（`151b0105a2e0…`）；§15.8 含「护栏 / 互斥」登记。

- [ ] **Step 3: CI 只追加一步**

```yaml
      - name: Verify phase4 delete scope (NO_DELETE_TARGET ratchet)
        run: python3 scripts/verify-phase4-delete-scope.py
```

插在 `Verify isMobileLayout scope` 之后、`Spec figures summary` 之前；不新建 job、不改 `package.json`。

- [ ] **Step 4: 写 runbook 与 13 章规格**，保留 runbook §7 四项准入契约与 `pc-visual-baseline.json` 只读约束。

- [ ] **Step 5: 全量判据转绿**

```bash
python3 scripts/verify-phase4-delete-scope.py --root /tmp/knives-master-full
```

预期：`V1..V7` 全 PASS、`VERDICT ALL_PASS NO_DELETE_TARGET`、`exit 0`。

---

### Task 3: 变异测试与负向自检

**Files:**
- Create: `docs/ops/2026-11-09-phase4-delete-scope-evidence.md`

- [ ] **Step 1: 在沙箱副本上跑 ≥10 组变异**

| ID | 注入 | 预期 |
| --- | --- | --- |
| M1 | manifest 漏登记 1 项 | `V1` RED |
| M2 | 改一条 `prod_refs` | `V2` RED |
| M3 | `delete_targets` 塞入活代码 | `V3` RED |
| M4 | 把双锚之一标为可删 | `V3`/`V4` RED |
| M5 | 真实删掉一个 `presentation/` 组件文件（行为级） | `V1`/`V2` RED |
| M6 | 母规格 §2 改一个字 | `V5` RED |
| M7 | `#` 注释伪装 CI 挂载 | `V6` RED |
| M8 | 只加注释不动实现 | 对照绿 |
| M9 | 掏空 `within_ratchet` | `V7` RED |
| M10 | `NO_DELETE_TARGET` → `ALL_PASS` | `V3` RED |
| M11 | 判据锚点只写进 `group_v*` 函数体 | `V7` RED |

- [ ] **Step 2: 恢复后核对 5 个交付文件裸 blob sha 全等**，写进证据文档。
- [ ] **Step 3: `pnpm verify-spec-figures` 与既有全量门禁**，登记 0 error / 2 个历史 warning 非本刀引入。

---

### Task 4: 入库闭环与状态回填

**Files:**
- Modify: `docs/ops/2026-11-09-phase4-delete-scope-evidence.md`（执行时状态回填）
- Modify: `.workbuddy/memory/2026-11-09.md`、`MEMORY.md`
- Issue #755（只追加评论与勾选）

- [ ] **Step 1: 推前逐路径裸 blob sha 比对 master**，基线前移则 `MASTER_MOVED_SAFE` 换 parent / `base_tree`。
- [ ] **Step 2: 走 `gh api` Git Data API 建分支 + PR**（正文用真实内容，回读 `body_len`）。
- [ ] **Step 3: 等 CI 三必需全 success；squash 合并；合并树核对差异恰为改动路径、parent 正确。**
- [ ] **Step 4: 零生产发布复核**（`deploy.yml` runs 不含本刀 sha；health/web 200）。
- [ ] **Step 5: Issue #755 / 日志 / MEMORY 只追加回填**，明确「删除刀按 §9 字面不可执行」这一新约束。

---

## Self-Review

- **Spec coverage**：§1 三目标 → Task 1/2/3；§2 不做项 → Global Constraints；§4 七判据 → Task 1 Step 2 + Task 3 变异；§6 S1–S7 → V1–V7 一一对应；§9 八个改动路径 → Task 1/2/3/4 全覆盖；§12 后继路线 → 证据文档诚实边界。
- **Placeholder scan**：无 TBD / TODO；每步给出命令与预期输出。
- **Type consistency**：`compute_inventory` 在 Task 1 定义、Task 2 `build_manifest` 消费，签名一致；`NO_DELETE_TARGET` 常量贯穿 manifest / verifier / runbook。
- **Review Focus**：五条各由 V1 / V2 / V3+V4 / 对照绿 / V5 覆盖。
