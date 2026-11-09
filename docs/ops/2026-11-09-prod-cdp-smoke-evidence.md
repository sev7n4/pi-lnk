# 路标 #4 参数化 CDP 五层冒烟 —— 本地与生产验收证据（2026-11-09）

> 对象：`scripts/prod-cdp-smoke.mjs`、`scripts/verify-prod-cdp-runbook.py`、`docs/ops/2026-11-09-prod-cdp-smoke-runbook.md`
> 规格：`docs/superpowers/specs/2026-11-09-prod-cdp-smoke-runbook-design.md`；计划：`docs/superpowers/plans/2026-11-09-prod-cdp-smoke-runbook.md`
> 结论口径：**只读跑法全绿**；不宣称复现真实回合（L3），不宣称 #4 已成为 CI 门禁。

## 1. 判据链（本地，零外部依赖）

### 1.1 verifier 七组

`python3 scripts/verify-prod-cdp-runbook.py` ⇒ **V1–V7 全 PASS / `exit 0`**：

| 组 | 结果 | 摘要 |
| --- | --- | --- |
| V1 | PASS | 零硬编码生产地址 / 站点端口 / 会话 id / 历史 token 路径，且无 session-scoped 视口修正 |
| V2 | PASS | `code=16 doc=16`：脚本 `env.LNKPI_*` 与 runbook §2 表格双向相等 |
| V3 | PASS | 三条 PREFLIGHT 齐备且 `await runPreflight` 先于 `await runLayers` |
| V4 | PASS | L3 默认 SKIPPED、写开关显式 opt-in、PASS 计数不含 SKIP |
| V5 | PASS | 五层源码判据数 4/5/19/13/3 与 runbook 表格一致 |
| V6 | PASS | workflows 与 `package.json` 均无本脚本接线 |
| V7 | PASS | runbook 逐条写明三条坑与「不挂 required check」 |

### 1.2 12 组变异（每条恢复后 3 文件裸 blob sha 全等）

| 变异 | 命中组 | 结果 |
| --- | --- | --- |
| M1 删 `Browser.setWindowBounds` | 仅 V3 | RED |
| M2 删 `/json/close/` | 仅 V3 | RED |
| M3 PREFLIGHT 移到判据之后 | 仅 V3 | RED |
| M4 移动端壳层静默放行 | 仅 V3 | RED |
| M5 写开关恒真 | 仅 V4 | RED |
| M6 塞回硬编码生产地址 | 仅 V1 | RED |
| M7 注释伪装 browser 锚点 | 仅 V3 | RED（`stripComments` 有效） |
| M8 runbook env 变量改名 | 仅 V2 | RED |
| M9 删一条 L0 判据 | 仅 V5 | RED |
| M10 把脚本挂进 CI | 仅 V6 | RED |
| M11 删 runbook 的 756px 实证 | 仅 V7 | RED |
| M12 纯注释伪变异对照 | 无 | 全绿（`exit 0`） |

`MUTATION_SUMMARY 12/12`、`FINAL_RESTORED exit=0`、`ALL_SHA_EQUAL True`。**V1–V7 每组至少一条精确 RED，失败组集合与预期完全相等**。

> 判据自纠：M11 首轮不 RED，原因是 runbook 中 `756` 出现两处而变异只替换首处 ⇒ verifier 输入未真正改变，属**伪变异**而非门禁失效。据此把 V7 锚点从泛化字符串收紧为 `innerWidth=756` / `session-scoped` / `/json/close/` 等具体短语，并把变异改为全文替换后精确 RED。

### 1.3 其它本地门禁

- `node --check scripts/prod-cdp-smoke.mjs` ⇒ `exit 0`。
- 缺失必填 env 负向自检 ⇒ `FATAL missing required env: LNKPI_BASE_URL, LNKPI_SESSION_ID, LNKPI_JWT_SUB`、`exit 1`，未连任何站点。
- `pnpm -s verify-spec-figures --file <新规格>` ⇒ **0 error / 0 warning**；全量 **203 篇 / 0 error**（2 个既有历史 warning 按纪律不动）；`verify-links` 0 error、`verify-claims` 7/7、`verify-agent-rail-gates` 11/11、`verify-web-upload` 13/13；新规格/计划占位符扫描 `NO_PLACEHOLDERS`。

## 2. 生产只读行为级验收

执行方式：独立 headless Chrome 156.0.8078.80（`--headless=new --no-sandbox --remote-debugging-port=9223`，全新 `--user-data-dir`），`node scripts/prod-cdp-smoke.mjs`，三个必填 env 由命令行提供，**未设置 `LNKPI_SMOKE_WRITE`**。

### 2.1 PREFLIGHT

| 闸门 | 实测 |
| --- | --- |
| P1 browser 级窗口修正 + 全新 session 复核 | `innerWidth=1440`，`LNKPI_MIN_PC_WIDTH=767` ⇒ PASS |
| P2 同 URL tab 清理 | `closed=0`，目标 tab 唯一 ⇒ PASS |
| P3 PC 布局断言 | `pcLayout=true fab=true aside=true` ⇒ PASS |

### 2.2 五层判据（30 PASS / 0 FAIL / 2 SKIP / 32 总计）

| 层 | 结果 | 关键实测 |
| --- | --- | --- |
| L0 | 4/4 PASS | 入口 `index-Ba3T3Qx-.js` / `index-B2xfeKqE.css` / 懒加载 `CanvasPage-lQRMDP9d.js` 均 200 |
| L1 | 5/5 PASS | health / sessions / threads / user messages（`count=80`）/ runtime-health 全 200 |
| L2 A 组 | 10/10 PASS | `appChildren=1`、`bodyTextLen=897`、`exceptionThrown=0`、`304=0`、token 已注入、`messageLike=304 / canvasLike=245 / railLike=84` |
| L2 B 组 | 9/9 PASS | 点 `button.agent-fab` 后 `asideWidth=500`、`shell=flex w=499`、turn/bubble 各 78、消息操作按钮 273、composer 4 个可见输入、发送按钮 7 |
| L3 | **SKIPPED** | `LNKPI_SMOKE_WRITE != 1，只读模式`；**零 POST 写操作** |
| L4 | 2 PASS + 1 SKIP | `vue-flow__node=25`、`vue-flow__edge=27`；`LNKPI_SHARE_ID` 未提供 ⇒ 分享页判据 SKIP 且不计 PASS |

`VERDICT pass=30 fail=0 skip=2 total=32`、`RUN_EXIT=0`。截图 `/tmp/lnkpi-smoke-shots/prod-cdp-smoke.png`；JWT secret 未回显、未落盘，短时 token 落 `/tmp/lnkpi-smoke-token`（0600）。Chrome 用 browser 级 `Browser.close` 收尾。

### 2.3 部署源旁证

L0 读到的懒加载 chunk 为 `CanvasPage-lQRMDP9d.js`，与 2026-11-08 P0+P3 固化刀部署后在生产 bundle 中核到的同一 chunk 名一致；本刀**不改前端产物**，该一致性说明验收对象是当前线上 dist，而非落后构建。

## 3. 诚实边界

- **不宣称 L3 行为被复现**：默认只读模式跳过真实回合；C 组 13 项代码路径由 V5 源级计数与 `docs/ops/2026-11-08-phase3-prod-smoke.md` 两轮 13/13 历史实证承接。若需复现，须显式 `LNKPI_SMOKE_WRITE=1`，会向生产写 1 个真实回合。
- **不宣称 #4 成为 CI 门禁**：门禁准入三问（零外部依赖 / 确定性 / 可失败）仍不满足；V6 变异证明「挂进 CI」会被判 RED。
- **不宣称复现任何产品缺陷**：本刀是取证工具固化，不是产品修复。
- **不触碰并行工作**：PR #787（P1+P2，11 文件，CI success）当时 open；本刀 9 个提交路径全在 `scripts/` 与 `docs/`，未覆盖 `apps/` / `services/` / `charts/` / `package.json` / workflows。

## 4. 索引

| 文档 | 内容 |
| --- | --- |
| `docs/ops/2026-11-09-prod-cdp-smoke-runbook.md` | env SSOT、三条坑、五层判据、退出码 |
| `docs/superpowers/specs/2026-11-09-prod-cdp-smoke-runbook-design.md` | 13 章规格与图 1 |
| `docs/superpowers/plans/2026-11-09-prod-cdp-smoke-runbook.md` | 7 Task 实施计划 |
| `docs/ops/2026-11-08-observer-refusal-exempt-prod-verify.md` | 三条 CDP 环境坑的原始实证 |

## 5. 收尾状态回填（2026-11-09 10:15，只追加）

- §3「PR #787 当时 open」是**实测当时**的事实，按「不追溯改写历史结论」保留。执行推送时该 PR 已 squash 合入 master `6d1f6936c9a2d56ed16e19300c075607dd84139d`（2026-11-08 17:18Z），并已单独发 runtime 版本。
- 推前 `python3 /tmp/runbook_push.py --check` 实证：`MASTER_MOVED_SAFE`（9 路径在 `683b29ef` → `6d1f6936` 之间 blob 完全一致）⇒ 本刀改用新 HEAD 作 parent；3 处只追加文档零删除/改写；#787 的 12 个改动文件与本刀 9 路径零重叠；`deploy.yml` 的 `push.paths` 不含 `docs/` / `scripts/` ⇒ 合并不触发生产发布。
- **不重跑已完成判据**：§1 的 V1–V7 / 12 组变异、§2 的生产只读 `30 PASS / 0 FAIL / 2 SKIP`、负向 env 自检均为已归档历史结论；收尾阶段只做 CI 天然触发项与合并树 blob sha 核对。
- **本轮排除、单列后续议题**：PR #625（SP-E 画布并发 CAS v2 规格，待评审）、A-6 真机复测（需用户设备与确认）。
