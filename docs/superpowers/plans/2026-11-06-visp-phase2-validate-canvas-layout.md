# VISP Phase 2 — `validate_canvas_layout` 确定性布局校验 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 VISP 规格 S-4 + Path C：确定性布局校验——`validateCanvasLayout` 纯函数（shared SSOT）+ `validate_canvas_layout` 工具（tier=present），让 agent 在批量建节点/整理布局/自述「没重叠」时以确定性报告为事实源（R-V6），不采信模型自述。

**Architecture:** 两层：① `@lnkpi/shared` 新增纯函数 `validateCanvasLayout`（复用 layout.ts 几何原语语义，OVERLAP/OVERFLOW/MIN_SPACING，severity 由几何阈值定）；② pi-runtime 新增常驻工具 `validate_canvas_layout`（只读 `get-canvas-layout` → NodeBox 映射 → **镜像实现** `validateCanvasLayoutLocal` → 报告）。pi-runtime 刻意不依赖 `@lnkpi/shared`（independence.test.ts 物理锁）⇒ 校验逻辑镜像 + contract-mirror 同源 fixture 锁 parity（canvas-group / read-media 先例）。无限画布范式下 `canvas` 边界可选：不传不判 OVERFLOW（R-V8 不编造）。

**Tech Stack:** `@lnkpi/shared`（vitest）、pi-runtime 工具框架（LnkpiTool/NestClient/typebox，node:test + tsx）、apps/web `toolPresentation.ts`。

**Spec:** `docs/superpowers/specs/2026-11-05-agent-canvas-visual-perception-design.md`（§2.1 S-4、§4.3 R-V5/R-V6/R-V8/R-V10/R-V11、§5.4、§8、§10 A-6、§12 Phase 2；R5 修订记录实施适配）

## Global Constraints

- 分支：`feat/visp-phase2-validate-layout`，基于 `feat/visp-read-media` HEAD（内容 == master `dabe9e72` 对本次触及文件；推送时 commit parent 用真实 master HEAD，tree 以 base_tree 挂真实 master 树防覆盖并行合并）。
- 本机命令纪律：shared/web 用 vitest + `env -u NODE_OPTIONS` + `--maxWorkers=1 --no-file-parallelism`；pi-runtime 用 node:test + `env -u NODE_OPTIONS ./node_modules/.bin/tsx --test`；推前 pi-runtime `tsc --noEmit`。
- 测试断言禁会破坏 CI 编译的 cast 形态；工具替身 cast 服从既有工具测试先例（remove-edges.test.ts）。
- L6 静态提示词**零改动**（R-V10）；新工具 tier=present **进 ALWAYS_ON 常驻集**（R-V6：校验闸门必须当轮可达；常驻 create/arrange 工具会制造它的场景 ⇒ 延迟即不可达）。
- 必做跨切（R-V11）：`config.test.ts` 三计数断言 48/50/48→49/51/49、web `toolPresentation.ts` 登记、`scripts/verify-tool-tiering.ts` + `verify-tool-contract.ts` 门禁绿。
- 改动 `services/pi-runtime/**` + `apps/web/**` ⇒ 合并后 dispatch `runtime-deploy`（tag = 全 40 位 SHA）+ `deploy.yml -f deploy_web_only=true`。

## Review Focus

1. **相切不报**：交集面积 0（边界相接）不得报 OVERLAP（§8-7 钉住）。
2. **无边界不编造**：`canvas` 缺省时 OVERFLOW 恒空（§8-4b 钉住，R-V8）。
3. **不双报**：重叠对同时满足 MIN_SPACING 时只报 OVERLAP（§8-8 钉住）。
4. **确定性**：同输入重复 3 次输出逐字节相同（§8-6 钉住，无随机源/无遍历顺序漂移）。
5. **Nest 失败 fail-soft**：布局读取失败 → `ok:false` 明确错误文本 + 「请勿编造校验结论」，不抛错不编造报告。
6. **镜像漂移**：shared 与 pi-runtime 两份实现由同源 fixture 锁；改任一侧 CI 即红。

---

### Task 1: shared 纯函数 `validateCanvasLayout`

**Files:**
- Modify: `packages/shared/src/canvas/layout.ts`（文件尾部追加）
- Test: `packages/shared/src/canvas/layout.test.ts`（追加 §8 describe）

- [x] **Step 1: 写失败测试**——§8 九条：无节点/不重叠在界内/重叠 120×80（severity=high）/右超 40px（severity=medium，仅提供 canvas）/canvas 缺省不判 OVERFLOW/minSpacing=20 间距 10（severity=low）/三次输出逐字节相同/相切不计/重叠对跳过 MIN_SPACING。
- [x] **Step 2: 跑 RED**（9 failed | 30 passed）。
- [x] **Step 3: 实现**——OVERLAP 成对 w>0&&h>0（severity=high）；OVERFLOW 仅 canvas 存在时逐节点聚合各边越界量（severity=medium）；MIN_SPACING 仅 minSpacing>0 且非重叠对，rectGap=max(Δx,Δy)（severity=low）；i<j 输入序遍历保确定性。
- [x] **Step 4: 跑 GREEN**（39/39；shared 全量 630/630）。

### Task 2: pi-runtime 工具 + 镜像

**Files:**
- New: `services/pi-runtime/src/tools/validate-canvas-layout.ts`
- New: `services/pi-runtime/src/tools/validate-canvas-layout.test.ts`（7 用例）
- New: `services/pi-runtime/src/tools/validate-canvas-layout.contract-mirror.test.ts`（同源 fixture 镜像锁）

- [x] **Step 1: 写失败测试**——tier=present；body 只带 sessionId；重叠 → OVERLAP + 报告含 id 与交集尺寸；干净画布 → 「未检出违规」；min_spacing 透传/缺省两态；Nest 失败 → ok:false fail-soft；schema 无 sessionId。
- [x] **Step 2: 跑 RED**（import 失败）。
- [x] **Step 3: 实现**——镜像 `validateCanvasLayoutLocal`（与 shared 逐语义一致）+ `formatViolationReport`（§5.4 报告形态）；NodeBox 从 `absolutePosition`+`size` 映射（服务端 getNodeSize 已算好，工具侧不实现尺寸表）；形态异常节点跳过（fail-soft 不编造几何）。
- [x] **Step 4: 跑 GREEN**（工具 7/7 + mirror 7/7）。

### Task 3: 接线与门禁

**Files:**
- Modify: `services/pi-runtime/src/tools/registry.ts`（`buildValidateCanvasLayoutTools` 导出）
- Modify: `services/pi-runtime/src/tools/config.ts`（装配，present 批次之后）
- Modify: `services/pi-runtime/src/tools/tiering.ts`（ALWAYS_ON 常驻 + 归属理由注释）
- Modify: `services/pi-runtime/src/tools/config.test.ts`（计数 48/50/48→49/51/49 + tier 断言）
- Modify: `apps/web/src/components/agent/toolPresentation.ts`（📏 校验布局）

- [x] 全部接线完成；`verify-tool-tiering`（注册 56/常驻 36，A5 展示注册全覆盖）+ `verify-tool-contract` 门禁绿。
- [x] 回归：pi-runtime tools 643/643 + src 727/727（含 independence 守卫）、web toolPresentation 10/10、shared 630/630、pi-runtime `tsc --noEmit` 干净。

### 验收与部署

- [ ] CI 绿 → squash merge → `runtime-deploy`（全 SHA tag，feature_grep=`validate_canvas_layout` / feature_file=`validate-canvas-layout.js`——实现代码非纯类型，dist 可 grep）+ `deploy_web_only=true`。
- [ ] A-6 真机验收：agent 自述「没重叠」→ 报告纠正（R-V6 行为级，用户侧复测）。
