# 发言被拒豁免与 question callId 精确配对（P0+P3 修复固化）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

spec-figures: off —— 理由：实施计划按 writing-plans 模板组织，两张结构图已在同名 spec 的 §0 / §5 / §8 承载，计划只描述执行步骤，不重复配图。

**Goal:** 把 2026-11-08 18:29 已实现并验证、但仍落在 `/tmp` 非 git 副本的 3 处前端修复，以 true master 为基固化进版本库并上线，同时补齐规格/计划/文档衔接、RED→PASS 与变异判据链、生产 CDP 复核。

**Architecture:** 三处改动全是既有收尾链的条件表达式：两条 finally 路径的空回合补句各加 `!agent.turnRefusal` 守卫；`waiting_user` resolved 翻 question part 的 `find` 谓词改为与 proposal 同口径的 callId 三态条件。无新接口、无新状态、无网络协议变更。判据分三层：CI 内确定性 vitest（行为级 + 源级契约）→ 本地全量门禁 → 合并后生产 CDP。

**Tech Stack:** Vue 3 SFC、TypeScript、Vitest 3.2.7、`gh api` Git-Data 链、GitHub Actions、自签 HS256 JWT + headless Chrome CDP。

**Spec:** `docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md`
**True master:** `45568b8c97b9d42bd804ebb785851b196c378844`（`gh api` 读取）
**执行方式:** 用户已明确「按 native 走」「继续推进」⇒ 本计划由当前会话连续执行全部 Task，不再逐阶段等待审阅。

---

## Global Constraints

- **真值来源**：本机 git 与工作树不可信；`apps/web` 是符号链接 → `/tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web`（HEAD `21056b8` 落后 true master 149 提交）。推前用 `gh api` 取 master HEAD + 全树，逐路径比对裸 blob sha（`sha1("blob %d\0" + data)`），差异文件先从 master blob 落盘再重放改动。
- **冻结边界**：`sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项（结项规格 §4.1）。#3 门禁基线（10 注入点 / 81 顶层键 / 17 回调型键）本刀不变。
- **提交链**：HTTPS git 被代理挡死、SSH key 不可用 ⇒ 全程 `gh api` Git-Data 链（blob → tree → commit → refs PATCH → pulls），tree entry 路径用 repo-root 相对路径；每次 `gh` 读写带 retry/backoff（曾遇 502）。
- **本机命令**：`export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH && unset NODE_OPTIONS`；vitest 在 `apps/web/node_modules/.bin/vitest`，用 `--maxWorkers=1 --no-file-parallelism`；Bash cwd 每条重置 ⇒ 内联 `cd <dir> &&`。
- **判据纪律**：基线 RED → 逐条变异 RED 且命中预期用例 → 恢复后 PASS 且裸 blob sha 全等；变异不 RED 先怀疑伪变异；注释伪变异必须仍全绿。**源级断言前一律 `stripComments`**（规格 §4 R3，本仓既有纪律），否则注释里写出同样的守卫字面量会假绿；M7 是这条纪律的有效性证明。
- **合并**：CI 三必需（Verify spec figures / Build monorepo / Build API Docker image）全绿后 `merge_method=squash`；合并树逐文件 blob sha 核对、删分支。
- **不追溯改写** P0 报告 / 结项规格 / #3 规格当时的历史验收结论，只追加状态演进。
- **不宣称**解决 20min 死挂；P1 批量澄清卡是独立大刀（规格 §12）。

---

## Review Focus

- 基线 RED 是否真的来自「实现未修复」而非「锚点切空」：必须出现 4 failed / 13 passed，且例 3 legacy 回落本就绿。
- 两处 P0 源级契约是否各自能 RED：只删一处守卫时，应只有对应那一条新用例红，不能两条都红或都不红。
- M5「守卫移到补句之后」是否真能 RED：若仍全绿，说明顺序断言是假门禁，必须先修判据。
- M7「注释伪装守卫」是否两处都 RED：若仍全绿，说明 `mainAckWiring.test.ts` 的 `stripComments` 加固没生效或被恢复步骤覆盖，禁止继续推 PR。
- 三态条件里的 `!d.callId` / `!p.callId` 两个回落是否被 M4 证明不是死代码。
- 推前是否逐路径核对 11 个文件，且没有把 `/tmp` 快照的落后内容或并行 PR 的改动带进 tree。
- 生产 CDP 是否诚实标注「未构造 steer 场景」，不得写 `ALL_PASS` 式笼统结论。

---

### Task 1: 以 true master 为基重建改动并证明基线 RED

**Files:**
- Read-only 源：`gh api repos/sev7n4/pi-lnk/git/trees/45568b8c...?recursive=1`
- 临时目录：`/tmp/p0p3-master/`（master blob 落盘）、`/tmp/p0p3-fixed/`（已验证版本备份）
- 工作树（经符号链接）：`/tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web/src/components/agent/`
- Test: `turnTimeline.callIdResolve.test.ts`（3 例）、`AgentSideRail.mainAckWiring.test.ts`（8 例）、`AgentSideRail.turnSuspended.test.ts`（6 例）

**Interfaces:**
- Consumes: master `45568b8c` 的 6 个产品文件 blob sha；本仓 `delivery.md` 的推前核对纪律。
- Produces: `/tmp/p0p3-fixed/` 里 6 个已验证文件的精确副本 + 一个可复跑的「基线 RED」工作树状态。

- [ ] **Step 1: 取 master 全树并逐路径核对 6 个产品文件 + 4 份拟衔接文档**

```bash
cd /Users/4seven/workspace/pi-lnk && python3 - <<'PY'
import subprocess,hashlib,os,base64,time
SHA='45568b8c97b9d42bd804ebb785851b196c378844'
def gh(args,tries=4):
    for i in range(tries):
        p=subprocess.run(['gh','api']+args,capture_output=True,text=True)
        if p.returncode==0:return p.stdout
        time.sleep(2*(i+1))
    raise RuntimeError(p.stderr)
out=gh([f'repos/sev7n4/pi-lnk/git/trees/{SHA}?recursive=1','--jq','.tree[] | select(.type=="blob") | "\(.path)\t\(.sha)"'])
m={l.split('\t')[0]:l.split('\t')[1] for l in out.strip().split('\n') if '\t' in l}
ROOT='/tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/'
paths=[
 'apps/web/src/components/agent/useAgentObserver.ts',
 'apps/web/src/components/agent/AgentSideRail.vue',
 'apps/web/src/components/agent/turnTimeline.ts',
 'apps/web/src/components/agent/AgentSideRail.mainAckWiring.test.ts',
 'apps/web/src/components/agent/AgentSideRail.turnSuspended.test.ts',
 'apps/web/src/components/agent/turnTimeline.callIdResolve.test.ts',
 'docs/superpowers/specs/2026-11-08-agent-siderail-p4-gates-design.md',
 'docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md',
 'docs/ops/2026-11-08-phase3-prod-smoke.md',
 'docs/superpowers/plans/2026-11-08-agent-siderail-p4-gates.md',
]
os.makedirs('/tmp/p0p3-master',exist_ok=True)
for p in paths:
    fp=ROOT+p if p.startswith('apps/') else '/Users/4seven/workspace/pi-lnk/'+p
    b=open(fp,'rb').read() if os.path.isfile(fp) else b''
    ls=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
    print(('SAME ' if m.get(p)==ls else 'DIFF '),p,'master',m.get(p,'ABSENT'),'local',ls)
    if m.get(p):
        raw=gh([f'repos/sev7n4/pi-lnk/git/blobs/{m[p]}','--jq','.content'])
        data=base64.b64decode(raw.replace('\n',''))
        assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==m[p]
        open('/tmp/p0p3-master/'+p.replace('/','__'),'wb').write(data)
PY
```

Expected: 3 个实现文件 + 2 个既有测试 + 1 个新增测试 **DIFF**，其中新增测试 `master=ABSENT`；4 份文档全部 **SAME**。若任一文档 DIFF，必须先下载 master blob 落盘、在其上追加，禁止直接推本地版本。

- [ ] **Step 2: 备份已验证的 6 个文件，逐字节校验**

```bash
mkdir -p /tmp/p0p3-fixed && cd /tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web/src/components/agent && for f in useAgentObserver.ts AgentSideRail.vue turnTimeline.ts turnTimeline.callIdResolve.test.ts AgentSideRail.mainAckWiring.test.ts AgentSideRail.turnSuspended.test.ts; do cp "$f" "/tmp/p0p3-fixed/$f" && shasum -a 256 "/tmp/p0p3-fixed/$f"; done
```

Expected: 6 行 sha256 输出；后续所有恢复都从 `/tmp/p0p3-fixed/` 取，禁止凭记忆重写。

- [ ] **Step 3: 把 3 个实现文件替换为 master 原版，构造未修复基线**

```bash
cd /tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web/src/components/agent && cp /tmp/p0p3-master/apps__web__src__components__agent__useAgentObserver.ts useAgentObserver.ts && cp /tmp/p0p3-master/apps__web__src__components__agent__AgentSideRail.vue AgentSideRail.vue && cp /tmp/p0p3-master/apps__web__src__components__agent__turnTimeline.ts turnTimeline.ts
```

- [ ] **Step 4: 跑基线，必须 RED**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && env -u NODE_OPTIONS PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism src/components/agent/turnTimeline.callIdResolve.test.ts src/components/agent/AgentSideRail.mainAckWiring.test.ts src/components/agent/AgentSideRail.turnSuspended.test.ts 2>&1 | tail -n 40
```

Expected: `Test Files 3 failed`、`Tests 4 failed / 13 passed`、EXIT=1。红的是 `callIdResolve` 例 1「多张卡精确翻」与例 2「不匹配不得误翻」、`mainAckWiring` 的 `!agent.turnRefusal` 例、`turnSuspended` 的 `!agent.turnRefusal` 例；`callIdResolve` 例 3「legacy 回落首张」应为绿（旧逻辑也翻首张），13 个既有用例全绿 ⇒ 证明 RED 不是锚点切空造成的假红。

---

### Task 2: 重放已验证修复并证明 PASS

**Files:**
- Modify: 3 个实现文件（从 `/tmp/p0p3-fixed/` 恢复）
- Test: 同 Task 1 的 3 个测试文件

**Interfaces:**
- Consumes: Task 1 的 `/tmp/p0p3-fixed/` 精确副本。
- Produces: 工作树回到已验证修复态，17/17 全绿，供 Task 3 变异使用。

- [ ] **Step 1: 恢复 3 个实现文件**

```bash
cd /tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web/src/components/agent && cp /tmp/p0p3-fixed/useAgentObserver.ts useAgentObserver.ts && cp /tmp/p0p3-fixed/AgentSideRail.vue AgentSideRail.vue && cp /tmp/p0p3-fixed/turnTimeline.ts turnTimeline.ts
```

- [ ] **Step 2: 核对恢复后的裸 blob sha 与备份全等**

```bash
cd /tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web/src/components/agent && python3 - <<'PY'
import hashlib,os
for f in ['useAgentObserver.ts','AgentSideRail.vue','turnTimeline.ts']:
    a=open(f,'rb').read(); b=open('/tmp/p0p3-fixed/'+f,'rb').read()
    assert a==b, f
    print('OK',f,hashlib.sha1(b'blob '+str(len(a)).encode()+b'\0'+a).hexdigest(),len(a))
PY
```

- [ ] **Step 3: 跑修复后判据，必须 PASS**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && env -u NODE_OPTIONS PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism src/components/agent/turnTimeline.callIdResolve.test.ts src/components/agent/AgentSideRail.mainAckWiring.test.ts src/components/agent/AgentSideRail.turnSuspended.test.ts 2>&1 | tail -n 20
```

Expected: `Test Files 3 passed (3)`、`Tests 17 passed (17)`、EXIT=0。实测已通过（2026-11-08 20:25，vitest 3.2.7）。

---

### Task 3: 逐条变异 RED → 恢复 → 裸 blob sha 全等

**Files:**
- Modify（临时）：3 个实现文件 + 2 个测试文件（M6 伪变异、M7 注释伪装守卫）
- 恢复源：`/tmp/p0p3-fixed/`（含 `mainAckWiring.test.ts` 的 `stripComments` 加固版本）

**Interfaces:**
- Consumes: Task 2 的全绿状态与 `/tmp/p0p3-fixed/` 的 6 个精确副本。
- Produces: 9 组变异记录（8 组应红 + M6 伪变异对照应绿）+ 恢复后 6 文件裸 blob sha 全等 + 判据复跑全绿。

⚠️ **前置加固（规格 §4 R3）**：`mainAckWiring.test.ts` 的新断言必须读 `OBS_CODE = stripComments(OBS)`，与既有 `AgentSideRail.observerRefusalExempt.test.ts` / `turnSuspended.test.ts` 同纪律；未加固时 M7 会假绿。`/tmp/p0p3-fixed/` 的备份必须是加固后的版本，否则恢复会把加固覆盖掉。

- [ ] **Step 1: M1 回退 turnTimeline 谓词**

```bash
cd /tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web/src/components/agent && python3 - <<'PY'
p='turnTimeline.ts'; s=open(p).read()
old="p.kind === 'question' && (!d.callId || !p.callId || p.callId === d.callId),"
assert old in s
open(p,'w').write(s.replace(old,"p.kind === 'question',",1))
PY
```

Run 同 Task 2 Step 3 命令。Expected: `callIdResolve` 例 1、例 2 红（2 failed / 15 passed）。恢复 `cp /tmp/p0p3-fixed/turnTimeline.ts turnTimeline.ts`。

- [ ] **Step 2: M2 移除 observer 守卫**

```bash
cd /tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web/src/components/agent && python3 -c "
p='useAgentObserver.ts'; s=open(p).read(); assert '    !agent.turnRefusal &&\n' in s; open(p,'w').write(s.replace('    !agent.turnRefusal &&\n','',1))"
```

Expected: 仅 `mainAckWiring` 新增例红（1 failed / 16 passed），`turnSuspended` 新增例仍绿 ⇒ 证明两条源级契约各自独立。恢复 `cp /tmp/p0p3-fixed/useAgentObserver.ts useAgentObserver.ts`。

- [ ] **Step 3: M3 移除 SFC 守卫**

同上，把 `AgentSideRail.vue` 里的 `      !agent.turnRefusal &&\n` 删掉。Expected: 仅 `turnSuspended` 新增例红。恢复 `cp /tmp/p0p3-fixed/AgentSideRail.vue AgentSideRail.vue`。

- [ ] **Step 4: M4 删两个 legacy 回落**

```bash
cd /tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web/src/components/agent && python3 -c "
p='turnTimeline.ts'; s=open(p).read(); old='p.kind === \'question\' && (!d.callId || !p.callId || p.callId === d.callId),'; assert old in s; open(p,'w').write(s.replace(old,\"p.kind === 'question' && p.callId === d.callId,\",1))"
```

Expected: `callIdResolve` 例 3「legacy 回落首张」红（1 failed / 16 passed）⇒ 证明两个回落不是死代码。恢复。

- [ ] **Step 5: M5 把守卫移到补句之后（顺序断言必须 RED）**

分别在 `useAgentObserver.ts` 与 `AgentSideRail.vue` 中，把 `!agent.turnRefusal &&` 从 `if (` 条件块里删掉，并追加到 `agent.appendText(...)` 之后作为一条无副作用表达式所在的新行（例如紧随补句调用插入 `void agent.turnRefusal` 与一行注释，使源文本里仍存在 `!agent.turnRefusal` 字面量但位置在文案之后）。Expected: 两次分别让 `mainAckWiring` / `turnSuspended` 的顺序断言红；若仍全绿 ⇒ 判据是「只查字符串存在」的假门禁，必须先加位置断言再继续。每次恢复后再做下一处。

- [ ] **Step 6: M6 注释伪变异对照（必须仍全绿）**

在 `turnTimeline.ts` 的配对代码上方追加一行 `// 注释伪变异对照`，跑判据。Expected: `Tests 17 passed (17)`、EXIT=0。恢复。

- [ ] **Step 7: M7 注释伪装守卫（R3 加固的有效性证明，两处都必须 RED）**

把 `useAgentObserver.ts` 的 `    !agent.turnRefusal &&\n` 替换为 `    // !agent.turnRefusal\n`（**注释留在守卫原位置**），跑判据 ⇒ `mainAckWiring` 新增例红；恢复后对 `AgentSideRail.vue` 的 `      !agent.turnRefusal &&\n` 做同样替换 ⇒ `turnSuspended` 新增例红。原理：未 `stripComments` 时 `guardIdx` 会命中注释且顺序正确 ⇒ 假绿；加固后 `guardIdx = -1` ⇒ 精确红。若仍全绿，说明加固没有生效，停止推 PR 先修判据。

- [ ] **Step 8: 全量恢复 + 6 文件裸 blob sha 核对 + 判据复跑**

```bash
cd /tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web/src/components/agent && for f in useAgentObserver.ts AgentSideRail.vue turnTimeline.ts turnTimeline.callIdResolve.test.ts AgentSideRail.mainAckWiring.test.ts AgentSideRail.turnSuspended.test.ts; do cp "/tmp/p0p3-fixed/$f" "$f"; done && python3 - <<'PY'
import hashlib
for f in ['useAgentObserver.ts','AgentSideRail.vue','turnTimeline.ts','turnTimeline.callIdResolve.test.ts','AgentSideRail.mainAckWiring.test.ts','AgentSideRail.turnSuspended.test.ts']:
    b=open(f,'rb').read()
    print(f,hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest())
PY
```

Expected: 6 个 sha 与 Task 1 Step 2 记录全等（注意 `mainAckWiring.test.ts` 的 sha 已是 `stripComments` 加固后的值）；再跑 Task 2 Step 3 命令 ⇒ 17/17 全绿。把 9 组变异（8 红 + M6 对照绿）的实际 RED 计数写入证据文档。

---

### Task 4: 文档衔接（只追加，不改写历史结论）

**Files:**
- Create: `docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md`（已产出）
- Create: `docs/superpowers/plans/2026-11-08-agent-observer-refusal-exempt.md`（本文，已产出）
- Modify: `docs/superpowers/specs/2026-11-08-agent-siderail-p4-gates-design.md` §12
- Modify: `docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md` §5
- Modify: `docs/ops/2026-11-08-phase3-prod-smoke.md` §6

**Interfaces:**
- Consumes: Task 1 Step 1 确认的 3 份文档与 master blob 完全一致。
- Produces: 3 处追加式状态衔接，使 #3 §12 路标、结项 §5 交接、P0 报告 §6 结论都能指到本刀。

- [ ] **Step 1: #3 P4 规格 §12 首行插入插队刀条目**

在 `## 12. 后续包 / 路线图（本包外的东西也登记）` 后的第一条之前插入：

```markdown
- ⭐ **插队刀（2026-11-08，优先级高于 #4）**：P0+P3 产品修复固化——两处空回合兜底豁免 `agent.turnRefusal`、`waiting_user` resolved 按 `callId` 精确翻 question part。起因是生产会话 `cmw7kmv3x01q4r401i7ir33b4` 的 PM/架构诊断，且已验证改动仍落在 `/tmp` 非 git 副本、随时可能丢失；规格与计划见 `docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md`。**#4 顺延到本刀合并后，不取消、仍不挂 required check。**
```

- [ ] **Step 2: 结项规格 §5 交接表「本地工作树大面积漂移」行追加注记**

把该行「现状」单元格末尾追加：`；2026-11-08 追加：`apps/web` 为符号链接指向 `/tmp` 非 git 副本，已验证但未提交的 P0+P3 修复已由插队刀以 true master blob 为基固化（见 `docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md` §3.2 / §11）`。不改该行其它文字。

- [ ] **Step 3: P0 报告 §6 追加第 4 条**

```markdown
4. **后续插队刀（2026-11-08 晚）**：P4 门禁化（#3，PR #783 / #784）已闭环；此后由生产会话诊断触发 P0+P3 产品修复固化插队，优先于 #4 CDP 五层冒烟参数化 ops runbook，后者顺延不取消。规格见 `docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md`；本条只追加状态演进，不改写上方第 1–3 条当时的结论。
```

- [ ] **Step 4: 自审 3 处追加没有改动历史结论**

```bash
cd /Users/4seven/workspace/pi-lnk && grep -n "插队刀\|顺延\|非 git 副本" docs/superpowers/specs/2026-11-08-agent-siderail-p4-gates-design.md docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md docs/ops/2026-11-08-phase3-prod-smoke.md
```

Expected: 3 份文档各命中 1 处新增；原有 `ALL_PASS` / `未发现` / `已承接` 等历史表述逐字保留。

---

### Task 5: 本地全量门禁

**Files:** 无新增；跑命令。

- [ ] **Step 1: 类型与构建**

```bash
cd /Users/4seven/workspace/pi-lnk && export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH && unset NODE_OPTIONS && pnpm --filter @lnkpi/web exec vue-tsc -b && pnpm -r build
```

Expected: 两个 EXIT=0；`pnpm -r build` 只允许既有 chunk-size warning。⚠️ `vue-tsc -b` 会编译 `src/**/*.ts`（含 `*.test.ts`），新测试里的 `as never` 若报错必须改类型而非删断言。

- [ ] **Step 2: 全 agent 组测试**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && env -u NODE_OPTIONS PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism src/components/agent 2>&1 | tail -n 25
```

Expected: 全绿、`Errors 0`（基线为 #3 的 121 files / 1059 tests，本刀 +1 file / +5 tests）。

- [ ] **Step 3: 文档与门禁校验**

```bash
cd /Users/4seven/workspace/pi-lnk && pnpm verify-spec-figures && pnpm verify-spec-figures --file docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md && pnpm verify-spec-figures --file docs/superpowers/plans/2026-11-08-agent-observer-refusal-exempt.md && pnpm verify-links && pnpm verify-claims && pnpm verify-agent-rail-gates && pnpm verify-web-upload
```

Expected: 全量 0 error；新规格逐篇 0 error / 0 warning；新计划因 `spec-figures: off` 跳过并打印提示；links 0；claims 7/7；rail gates 11/11；web upload 13/13。把实际数值回填规格 §13。

- [ ] **Step 4: 规格/计划自审（无占位符、无自相矛盾）**

```bash
cd /Users/4seven/workspace/pi-lnk && grep -nE "TB""D|TO""DO|待""填|稍""后""补|implement ""later" docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md docs/superpowers/plans/2026-11-08-agent-observer-refusal-exempt.md || echo "NO_PLACEHOLDERS"
```

Expected: `NO_PLACEHOLDERS`；并核对规格里「6 个产品文件 / 11 个合并树文件 / 4 failed 13 passed」三处数字与实测一致。

---

### Task 6: 推 PR、CI 三必需、squash 合并、合并树核对

**Files:** 11 个（6 产品 + 2 新文档 + 3 衔接文档）。

- [ ] **Step 1: 推前逐路径 blob sha 核对（R5）**

用 Task 1 Step 1 的脚本重跑一次，把 `paths` 换成 11 个提交文件；对 3 份衔接文档额外确认「本地 = master 原版 + 本刀追加」，即 `diff` 只含新增行。⚠️ 若期间 master 被并行 PR 前移，改用新 master tree 作 `base_tree`、新 HEAD 作 parent，并把并行 PR 的差异 blob 落盘核对，只覆盖自己的文件。

- [ ] **Step 2: gh api Git-Data 链提交**

```bash
cd /Users/4seven/workspace/pi-lnk && python3 - <<'PY'
import subprocess,json,base64,hashlib,time,os
REPO='sev7n4/pi-lnk'; PARENT='45568b8c97b9d42bd804ebb785851b196c378844'
BRANCH='phase4/observer-refusal-exempt-20261108'
ROOTS={'apps/':'/tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/','docs/':'/Users/4seven/workspace/pi-lnk/'}
paths=[
 'apps/web/src/components/agent/useAgentObserver.ts',
 'apps/web/src/components/agent/AgentSideRail.vue',
 'apps/web/src/components/agent/turnTimeline.ts',
 'apps/web/src/components/agent/turnTimeline.callIdResolve.test.ts',
 'apps/web/src/components/agent/AgentSideRail.mainAckWiring.test.ts',
 'apps/web/src/components/agent/AgentSideRail.turnSuspended.test.ts',
 'docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md',
 'docs/superpowers/plans/2026-11-08-agent-observer-refusal-exempt.md',
 'docs/superpowers/specs/2026-11-08-agent-siderail-p4-gates-design.md',
 'docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md',
 'docs/ops/2026-11-08-phase3-prod-smoke.md',
]
def gh(method,route,body=None):
    args=['gh','api','-X',method,route]
    if body is not None:
        args+=['--input','-']
    for i in range(4):
        p=subprocess.run(args,capture_output=True,text=True,input=json.dumps(body) if body is not None else None)
        if p.returncode==0:return json.loads(p.stdout or '{}')
        time.sleep(2*(i+1))
    raise RuntimeError(p.stderr)
def blob(path):
    root=next(v for k,v in ROOTS.items() if path.startswith(k))
    data=open(root+path,'rb').read()
    return gh('POST',f'repos/{REPO}/git/blobs',{'content':base64.b64encode(data).decode(),'encoding':'base64'})['sha'],hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
entries=[]
for p in paths:
    s,local=blob(p)
    assert s==local,(p,s,local)
    entries.append({'path':p,'mode':'100644','type':'blob','sha':s})
base=gh('GET',f'repos/{REPO}/git/commits/{PARENT}')['tree']['sha']
tree=gh('POST',f'repos/{REPO}/git/trees',{'base_tree':base,'tree':entries})['sha']
c=gh('POST',f'repos/{REPO}/git/commits',{'message':'fix(agent): 发言被拒豁免空回合补句 + question callId 精确配对（P0+P3 固化）','tree':tree,'parents':[PARENT]})['sha']
gh('POST',f'repos/{REPO}/git/refs',{'ref':f'refs/heads/{BRANCH}','sha':c})
pr=gh('POST',f'repos/{REPO}/pulls',{'title':'fix(agent): P0+P3 修复固化（turnRefusal 豁免 / callId 精确配对）','head':BRANCH,'base':'master','body':'规格与计划见 docs/superpowers/specs 与 plans 下 2026-11-08-agent-observer-refusal-exempt-*。行为级 RED→PASS、9 组变异（含 M7 注释伪装守卫）、本地全量门禁见计划 Task 1–5。'})
print('COMMIT',c,'TREE',tree,'PR',pr['number'],pr['html_url'])
PY
```

⚠️ `ROOTS` 映射决定每个文件从哪份工作树读取：`apps/` 走 `/tmp` 符号链接真实源，`docs/` 走主仓工作树；执行前必须确认 Task 6 Step 1 的 11 个路径逐个存在且本刀改动的裸 sha 与预期一致。Expected: 每个 blob 的 API 返回 sha 与本地裸 sha 相等；compare 恰好 11 个文件、无幻影文件。

- [ ] **Step 3: 等 CI 三必需全 pass**

用带 retry 的 `gh api repos/sev7n4/pi-lnk/actions/runs/<id>` 轮询，不用 `gh run watch`（502 会打断）。Expected: `Verify spec figures` / `Build monorepo` / `Build API Docker image` 全 success；任一步骤含新增测试文件的 tsc 错误必须修，不能跳过。

- [ ] **Step 4: squash 合并 + 合并树核对**

```bash
gh api -X PUT repos/sev7n4/pi-lnk/pulls/<N>/merge --input - <<'JSON'
{"merge_method":"squash","commit_title":"fix(agent): P0+P3 修复固化（turnRefusal 豁免 / callId 精确配对）"}
JSON
```

然后取新 master tree，对 11 个路径逐一比对 API blob sha 与本地裸 sha；删分支 `gh api -X DELETE repos/sev7n4/pi-lnk/git/refs/heads/<BRANCH>`；`curl -s -o /dev/null -w "%{http_code}" https://<host>/api/health` 应为 200（API 容器重建窗口可能短暂 502，按 runbook 间隔 20s 连续复查三次，不 rerun、不手动兜底）。

---

### Task 7: 生产部署、CDP 行为复核、证据归档

**Files:**
- Create: `docs/ops/2026-11-08-observer-refusal-exempt-prod-verify.md`（证据文档，随归档 PR 提交）
- Modify: 规格 §10 / §13 回填实际数值（随归档 PR 提交）

- [ ] **Step 1: 等自动部署 success**

`deploy.yml` 的 `push.paths` 含 `apps/web/**` ⇒ push master 自动触发。Expected: 整条 run success；日志含 `UPLOAD_MODE=incremental` / `MANIFEST_OK files=163` / `WEB_DIST_UPLOAD_OK`；远端 `sha256sum -c` exit 0；web 首页与 `/api/health` 200。20min 内不 cancel；若上传变慢，先 `stat` 两次看 tgz 字节是否仍增长，不 rerun。

- [ ] **Step 2: 自签 JWT + headless Chrome CDP 复核**

复用 #780 / F1 的姿势：`ssh deploy-cvm "docker exec lnkpi-api printenv JWT_SECRET"` 读密钥到内存（不落盘不回显）→ Python `hmac-sha256` 自签 HS256 `{sub,iat,exp}` 1h → `Page.addScriptToEvaluateOnNewDocument` 注入 `localStorage.token`；独立实例 `--headless=new --no-sandbox --disable-gpu --remote-debugging-port=9223 --user-data-dir=/tmp/p0p3-chrome-profile`；Node 原生 `WebSocket` 直连 `webSocketDebuggerUrl`。判据：点 `button.agent-fab` 展开侧栏后 aside 宽度 500px、真实前端短回合 ack `{"code":0,"data":{"accepted":true,…}}`、owner 流 finalize、DOM turn +2、`Runtime.exceptionThrown` 与 console error 均为 0。⚠️ 侧栏默认收起，只查 `querySelectorAll().length` 是假绿，必须判 rect/computed display。

- [ ] **Step 3: 诚实标注 steer 场景**

`turnRefusal` 需要 409 steer 窗口才能稳定构造。若当次构造成功，记录 callout 出现且「本轮无文本回复」不出现；若未构造成功，证据文档写「本刀生产复核覆盖零异常 + 常规真实回合不回归，**未复现 steer 场景**，P0 的行为保证由两处源级契约 + 本地 17/17 判据承接」，**不写 `ALL_PASS` 式笼统结论**。

- [ ] **Step 4: 归档 PR + 回填规格 + 工作日志**

证据文档与规格 §10/§13 数值回填走独立小 PR（纯文档，不触发部署），CI 三必需全 pass 后 squash。最后把「master 新 SHA、PR 编号、变异计数、部署 run 与 Upload 耗时、CDP 结论、#4 顺延状态」追加到 `.workbuddy/memory/2026-11-08.md`，并把 `/tmp` 副本的 6 个产品文件同步为合并后的 master 版本（消除漂移）。

---

## 计划自审（对照规格）

- **Spec coverage**：规格 §1 三条目标 → Task 1/2（固化 + 两处行为）、Task 6/7（上线复核）；§2 范围 11 文件 → Task 4/6 清单；§4 R1–R5（含 R3 的 `stripComments` 加固）→ Task 3 变异（M7 钉死加固）+ Task 6 推前核对 + Task 7 CDP；§6 场景 A–F → Task 1 基线、Task 2 PASS、Task 3 M1/M4、Task 7 steer；§10 L1/L2/L3 → Task 1–3 / Task 5 / Task 7；§11 六条风险 → Global Constraints 与 Task 7 Step 3；§12 后续包 → 规格原文保留、计划不越界。无缺口。
- **Placeholder scan**：Task 5 Step 4 的拆分字面量扫描命令输出 `NO_PLACEHOLDERS`（避免命令自身被自己扫中）；Task 6 Step 2 的 `paths` 已写全 11 个真实路径并给出 ROOTS 映射，其余步骤均含可执行命令或完整 Markdown 片段。
- **Type consistency**：`!agent.turnRefusal`、三态条件字符串、`/tmp/p0p3-fixed/`、`45568b8c…`、11 文件 / 17 tests / 4 failed 13 passed 在全文一致。
- **Review Focus**：五条分别由 Task 1 Step 4、Task 3 Step 2/3、Task 3 Step 5、Task 3 Step 4、Task 6 Step 1、Task 7 Step 3 钉住。
