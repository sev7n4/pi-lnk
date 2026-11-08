# AgentSideRail 契约门禁化（Phase 4 / #3 P4）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `defineExpose` 11 项冻结契约与「注入依赖数 / 回环数」从人工估算升级为零外部依赖、可失败、接进已有 required check 的源级门禁；零产品代码改动。

**Architecture:** 两条独立判据链共用一份解析器：`AgentSideRail.defineExpose.test.ts` 走 `build` job 已有的 `pnpm test`；`scripts/verify-agent-rail-gates.py` 挂 `spec-figures` job 新增一步。不新建 CI job、不引入网络/浏览器/凭据依赖。

**Tech Stack:** Vue 3 SFC 源文本、Vitest、Python 3 标准库、GitHub Actions `spec-figures` job、`gh api` Git-Data 提交链。

**Spec:** `docs/superpowers/specs/2026-11-08-agent-siderail-p4-gates-design.md`
**True master:** `8424bb023ab95c579d47270e1351679f8f7a4071`（`gh api` 读取）

---

## Global Constraints

- **零产品代码改动**：`AgentSideRail.vue`、全部 composable、`apps/**` 运行时源码一律不动；只新增测试/脚本/CI 步骤/文档。
- **冻结边界**：`sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项（结项规格 §4.1）。
- **真值来源**：本机 git 与工作树不可信；推前用 `gh api` 取 master HEAD + 全树，逐路径比对裸 blob sha（`sha1("blob %d\0" + data)`），差异文件先从 master blob 落盘再重放改动。
- **提交链**：HTTPS git 被代理挡死、SSH key 不可用 ⇒ 全程 `gh api` Git-Data 链（blob → tree → commit → refs PATCH → pulls），tree entry 路径用 repo-root 相对路径；每次 `gh` 读写带 retry/backoff（曾遇 502）。
- **本机命令**：`export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH && unset NODE_OPTIONS`；vitest 用 `--maxWorkers=1 --no-file-parallelism`；Bash cwd 每条重置 ⇒ 内联 `cd <dir> &&`。
- **判据纪律**：基线 RED → 逐条变异 RED 且命中预期组 → 恢复后 PASS 且裸 blob sha 全等；注释先剥离；否定断言配肯定断言；变异不 RED 先怀疑伪变异。
- **合并**：CI 三必需（Verify spec figures / Build monorepo / Build API Docker image）全绿后 `merge_method=squash`；合并树逐文件 blob sha 核对、删分支。
- **不追溯改写** P0 / 结项规格当时的历史验收结论，只追加状态演进。

---

## Review Focus

- 基线是否真的可算：10 个注入点 / 81 顶层键 / 17 回调型键 / 6 个 `*Deps` 接口 64 属性（规格 §8）。
- 三项显式决策有没有被悄悄绕过：CDP 脚本化不进本刀、本地树不做 CI 门禁、回环数只做代理指标。
- G2 双向配对是否覆盖「加键不改接口」与「接口加属性不传」两个方向。
- 新增的 CI 步骤是否落在**已有** `spec-figures` job，且没有新增 job / 改 required check 集合。

---

### Task 1: 写 `defineExpose` 类别化 ratchet

**Files:**
- Create: `apps/web/src/components/agent/AgentSideRail.defineExpose.test.ts`

- [ ] 读 `AgentSideRail.vue` 的 `defineExpose({ ... })` 块（按括号配平截取，不按行号），剥离块内注释后取顶层键名集合。
- [ ] 断言键名集合与结项规格 §4.1 的 11 项**精确相等**（`newAgentSession` / `openThreadHistory` / `closeThreadHistory` / `openPanel` / `closePanel` / `setComposerInput` / `addAttachment` / `reconcileFromNodes` / `confirmProposeWait` / `cancelProposeForNode` / `addFromCanvasNodes`）。
- [ ] 每项值做类别化配对：`obj.prop` → `obj` 必须有 `const obj = useXxx(` 定义；裸标识符 → SFC 内必须有 `const` / `function` / 解构定义；内联箭头函数 → 函数体非空。
- [ ] 配肯定断言：SFC 必须仍有 `defineExpose({`、`const threadApi = useAgentThread({`、`const composer = reactive(useAgentComposer({`、`const propose = useAgentPropose({`、`const sidebar = useSidebarAttachments()`，防「删空文件也能绿」。
- [ ] 本地 `vitest run` 定向该文件全绿；记录用例数。

### Task 2: 写门禁 verifier 并证明接线前 RED

**Files:**
- Create: `scripts/verify-agent-rail-gates.py`

- [ ] 实现解析器：`\b(use[A-Z]\w+)\s*\(\s*\{` 匹配 → 自 `{` 起逐字符配平（跳过 `//`、`/* */`、单双引号、模板串与转义）→ 深度 0 逗号切条目 → 冒号左侧取键名；值含 `=>` 记为回调型键。
- [ ] 实现 `*Deps` 接口属性解析：`interface \w*Deps\w* \{ ... \}`，剥离注释后取 2 空格缩进的 `name?:` 属性名。
- [ ] G2：6 个有接口的注入点，键集合与接口属性集合双向相等；不等则报出缺失/多余键名。
- [ ] G3：注入点总数 ≤ 10、顶层键总数 ≤ 81、回调型键总数 ≤ 17、每簇键数 ≤ 规格 §8 基线表、注入点名集合与白名单相等。
- [ ] G4：扫描 `apps/web/src/components/agent/AgentSideRail.*.test.ts` 的 `readFileSync` 相对目标，断言文件存在；断言 `defineExpose.test.ts` 存在。
- [ ] G5：`ci.yml` 的 `spec-figures` 段含 `pnpm verify-agent-rail-gates`；`package.json` scripts 含同名键且指向 `scripts/verify-agent-rail-gates.py`；脚本文件存在。
- [ ] 每组独立 `record` 输出 `PASS/FAIL + 组名 + 诊断`；任一红则 exit 1。
- [ ] **基线 RED**：G5 必红（CI/package 尚未接线）、整体 exit≠0；记录失败组号与其它组状态。

### Task 3: CI 与 package 接线，转 PASS

**Files:**
- Modify: `package.json`（`"verify-web-upload": ...` 之后）
- Modify: `.github/workflows/ci.yml`（`- name: Verify web dist upload contract` 之后）

- [ ] 新增 `"verify-agent-rail-gates": "python3 scripts/verify-agent-rail-gates.py"`。
- [ ] `spec-figures` job 新增 `- name: Verify agent rail contract gates` / `run: pnpm verify-agent-rail-gates`；**不新建 job**。
- [ ] 跑 `pnpm verify-agent-rail-gates`，要求 G1–G5 全 PASS、exit 0；保存实现文件裸 blob sha。

### Task 4: 逐条变异 RED→PASS

**Files:** 临时变异 `AgentSideRail.vue` / composable / 测试 / `ci.yml`，结束后**逐文件恢复**

- [ ] M1 删 `defineExpose` 一个键 → G1 红。
- [ ] M2 给 `useAgentQueue` 注入点加一键不改接口 → G2 + G3 红。
- [ ] M3 给 `AgentQueueDeps` 加一属性不改注入点 → G2 红。
- [ ] M4 新增一个回调型注入键 → G3 红。
- [ ] M5 把某 ratchet 的 `readFileSync` 目标改成不存在文件 → G4 红。
- [ ] M6 从 `ci.yml` 摘掉门禁步骤 → G5 红。
- [ ] M7 **伪变异对照**：在注释里写一个契约键名 → 必须仍然 PASS（判据不假绿）。
- [ ] 每条变异前断言源文件确实变化（防伪变异）；恢复后逐文件裸 blob sha 与固定版全等、全组 PASS。

> **Task 4 实测（2026-11-08）**：7/7 符合预期。M1 删 `closePanel` → G1 RED 且 vitest 同步 exit=1；M2 → G2 + G3 RED；M3 → G2 RED；M4（把 `queuedSlots` 改箭头函数，键集合不变、回读通道 +1）→ 仅 G3 RED；M5 → G4 RED；M6 → G5 RED；M7 注释伪变异 → verifier 11/11 + vitest exit=0。恢复后 13 文件裸 blob sha 全等、verifier 11/11 复绿。详见规格 §10。

### Task 5: 文档衔接与本地全量门禁

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md`（§5 交接表 3 行）
- Modify: `docs/superpowers/specs/2026-11-08-agent-siderail-p1-denoise-design.md`（§12 P4 行）
- Modify: `docs/ops/2026-11-08-phase3-prod-smoke.md`（§6 第 3 条）
- Modify: `docs/superpowers/specs/2026-11-08-web-dist-incremental-upload-design.md`（§12 后续包）

- [ ] 结项规格：追加「基线 7 / 55 / 5 为估算，已由 P4 规格 §3.2 重定义为 10 / 81 / 17 代理」指引，`defineExpose` / 注入依赖 / 陈旧 ratchet 三行标注已承接；**不改当时的验收结论**。
- [ ] P1 规格 §12 P4 行：标注本刀实现范围 + 「本地树不做 CI 门禁」显式结案。
- [ ] P0 报告 §6：下一优先级排序更新（F1 / #2 已完成，P4 已开刀，#4 CDP 脚本化待启）。
- [ ] #2 规格 §12：P4 从「下一步」改为「已开刀」。
- [ ] 跑 `pnpm verify-spec-figures`（全量 + 新规格逐篇）、`verify-links`、`verify-claims`；数字/链接/声明必须与实现一致。
- [ ] 跑定向 + 全 agent 组 vitest、`vue-tsc -b`、`pnpm -r build`；本地 SQLite 集成测试若因并行超时，单独 `--maxWorkers=1` 重跑确认非回归（#2 已实证）。
- [ ] 跑 `pnpm verify-web-upload` 确认上刀门禁未被本刀影响。

### Task 6: 推 PR、CI 三必需、squash、合并后核验

**Files:** 全部 10 个改动文件

- [ ] 推前：`gh api` 取 master HEAD 与全树，逐路径比对 10 个文件裸 blob sha；**差异文件先从 master 取 blob 落盘再重放改动**（#2 曾据此抓获本地缺 `patchedDependencies` 与 OG 播种）。
- [ ] Git-Data 链：逐文件 POST blob 并核对返回 sha → `base_tree=master tree` 建 tree → parent=master HEAD 建 commit → 建 `refs/heads/phase4/agent-rail-gates-20261108` → 开 PR；`compare` 核对文件清单恰为 10 个。
- [ ] 带 retry/backoff 轮询 CI；确认 `Verify spec figures` job 内新步骤 success、三必需全 pass。
- [ ] `merge_method=squash` 合并；合并树逐文件 blob sha 全等；删分支；`curl` 生产 web / `/api/health` 均 200。
- [ ] 本刀改 `package.json` 但**不改 `apps/web/**` 产品源码**；`deploy.yml` 的 `push.paths` 含 `package.json` ⇒ **会自动触发一次生产发布**。按规格 §10 的显式决策：保留惯例、不绕过、不改 paths；等待该 run success 并核对健康 200，记录其耗时作为 #2 上传链路第二次实测，但不把部署结论当本刀门禁验收判据。
- [ ] 回写 `.workbuddy/memory/2026-11-08.md` 与长期备忘（门禁基线值、三项决策、后续 #4）。

---

## Acceptance

1. `defineExpose` 11 项有单处类别化全覆盖 ratchet，删/改/增任一契约 CI 转红。
2. 注入依赖门禁机器可算、单调不增，接进**已有** `spec-figures` required check，无新 job、无外部依赖。
3. 接线前 RED、7 条变异（含 1 条伪变异对照）结果符合预期、恢复后 PASS 且裸 blob sha 全等。
4. 本地全量门禁与 CI 三必需全绿；合并树 10 文件 blob sha 全等；生产健康 200。
5. 规格/计划/衔接文档无规格-实现漂移；三项显式决策在报告与文档中措辞一致（回环是**代理指标**，不是「已实现 5 条回环门禁」）。
