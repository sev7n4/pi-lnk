# PC 会话页自动化视觉回归套件 · 本地验收证据（2026-11-09）

> 规格：`docs/superpowers/specs/2026-11-09-pc-visual-regression-harness-design.md`
> 计划：`docs/superpowers/plans/2026-11-09-pc-visual-regression-harness.md`
> runbook：`docs/ops/2026-11-09-pc-visual-regression-runbook.md`
> 写作时 true master：`aa4aa528a73eaff98042bb3f9171a4bc5e8d8fc0`（`gh api` 读取）

## 1. 交付清单（10 新增 + 1 处只追加衔接）

| # | 路径 | 类型 |
| --- | --- | --- |
| 1 | `docs/superpowers/specs/2026-11-09-pc-visual-regression-harness-design.md` | 新增（13 章 + §14 实现期补充） |
| 2 | `docs/superpowers/plans/2026-11-09-pc-visual-regression-harness.md` | 新增（7 Task + 执行时状态回填） |
| 3 | `docs/ops/2026-11-09-pc-visual-regression-runbook.md` | 新增 |
| 4 | `docs/ops/2026-11-09-pc-visual-regression-evidence.md` | 新增（本文） |
| 5 | `scripts/pc-visual-regression.mjs` | 新增 |
| 6 | `scripts/verify-pc-visual-regression.py` | 新增 |
| 7 | `scripts/fixtures/pc-visual-fixture.json` | 新增 |
| 8 | `scripts/fixtures/pc-visual-page.html` | 新增 |
| 9 | `scripts/fixtures/pc-visual.vite.config.mjs` | 新增 |
| 10 | `scripts/baselines/pc-visual-baseline.json` | 新增（golden，后续只读） |
| 11 | `docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md` | 只追加 §15.6 状态登记 |

零改动：`apps/web/**`、`services/**`、`charts/**`、`package.json`、`.github/workflows/**`，以及 `scripts/prod-cdp-smoke.mjs` / `scripts/verify-prod-cdp-runbook.py`。

## 2. T1 · V1–V7 静态判据

基线（只建 verifier、无实现）：`V1–V7` 全 FAIL、`VERDICT HAS_FAILURE V1,V2,V3,V4,V5,V6,V7`、`exit 1` —— 确认判据不是恒绿。

实现完成后：

```
PASS  V1  零硬编码，env 校验先于任何连接
PASS  V2  env 双向相等 9 项
PASS  V3  三条 PREFLIGHT 齐备且先于采集
PASS  V4  双跑 sha256 + 四固定齐备
PASS  V5  diff 三类 / SKIP 不计 PASS / PNG 不进退出码
PASS  V6  零 CI 接线，fixture/page/config/baseline 齐备且真实组件参与渲染
PASS  V7  三条坑 + 四项准入凭据 + baseline 只读契约齐备
VERDICT ALL_PASS   exit 0
```

## 3. T2 · 变异测试 11 组（≥8 组要求已超额）

每条均全文替换、恢复后 4 个目标文件（`pc-visual-regression.mjs` / verifier / runbook / fixture page）裸 blob sha 全等。

| 组 | 变异 | 结果 |
| --- | --- | --- |
| M1 | 删 `Browser.setWindowBounds` | `V3` RED，exit 1 |
| M2 | 删 `/json/close/` | `V3` RED，exit 1 |
| M3 | PREFLIGHT 移到采集之后 | `V3` RED，exit 1 |
| M4 | 双跑改单跑 | `V4` RED，exit 1 |
| M5 | `diffSnapshots` 恒返回空 | `V5` RED，exit 1 |
| M6 | SKIP 计入 PASS | `V5` RED，exit 1 |
| M7 | PNG 字节接进退出码 | `V5` RED，exit 1 |
| M8 | 删 runbook 准入契约 | `V7` RED，exit 1 |
| M9 | 关键锚点只写进注释 | `V3` RED（证明 `strip_comments` 有效） |
| M10 | 追加一行无关注释（伪变异对照） | 全绿、exit 0 |
| M11 | **行为级**：fixture 页少渲染一个真实组件 | 真实运行 `diff_nonzero=True`、exit 1 |

`SUMMARY 11/11 OK, 0 BAD`。M11 是防「伪绿 baseline」（规格 R1）的直接实证：删除 `presentation/` 组件渲染会改变 DOM 并被确定性 diff 抓住，不是只靠源级字符串断言。

## 4. T3 · 真实本地运行（全新 Chrome 进程）

前置：本地 Vite 服务 `http://127.0.0.1:5199/pc-visual-page.html`（`curl --noproxy '*'` 200），Chrome 156 headless 带 `--no-proxy-server`。仅设 3 个必填 env。

```
PREFLIGHT chrome=Chrome/156.0.8078.80 cdp=127.0.0.1:9224
PREFLIGHT P2 PASS closed=0 tab=5B1B8E05613E724C8E87CB77192B202B
PREFLIGHT P1 PASS innerWidth=1440 min=767
PREFLIGHT P3 PASS innerWidth=1440 hosts=2 nodes=100
DETERMINISM_OK sha256=82d36fe47f22b5410e191e6299a9abebac83429accfc7fbf30baa40be59377b2
diff_count=0
PNG /tmp/pc-visual-shots/pc-visual-current.png
SHA_A 82d36fe47f22b5410e191e6299a9abebac83429accfc7fbf30baa40be59377b2
SHA_B 82d36fe47f22b5410e191e6299a9abebac83429accfc7fbf30baa40be59377b2
VERDICT ALL_PASS pass=4 fail=0
RUN_EXIT=0
```

- 基线 `elements=101`、`viewport={w:1440,h:757}`（headless 窗口占用，跨进程稳定复现）。
- 同一 fixture 两次采集 `sha256` 逐字节相等；换全新 Chrome 进程复跑仍得到同一哈希 ⇒ 确定性不是同进程巧合。
- 产物：`/tmp/pc-visual-shots/pc-visual-current.json`（59,995 B）与 `pc-visual-current.png`（84,698 B）。PNG 仅目视附件，不进退出码。
- **负向**：去掉 3 个必填 env ⇒ `FATAL missing required env: LNKPI_PC_BASE_URL, LNKPI_PC_CDP_PORT, LNKPI_PC_SHOT_DIR`、`NEG_EXIT=1`，未启动 Chrome、未访问任何站点。

## 5. T4 · 本地全量门禁

| 门禁 | 结果 |
| --- | --- |
| `verify-spec-figures --file <本规格>` | 0 error / 0 warning，exit 0 |
| `verify-spec-figures`（全量 206 篇） | 0 error / **2 个既有 warning**（`2026-10-04-metrics-observability-design.md` R4，非本刀引入），exit 0 |
| `verify-links` | exit 0 |
| `verify-claims` | 7/7 |
| `verify-agent-rail-gates` | 11/11 |
| `verify-web-upload` | 13/13 |
| `verify-pc-visual-regression`（V1–V7） | ALL_PASS |
| `node --check`（采集脚本 + vite config） | OK |
| 占位符扫描（5 个交付文件） | 零命中 |

## 6. 诚实边界

- **不宣称**完成了母规格 Phase 4「删 `presentation/` 下 1100–1450 行 PC 冗余渲染」—— 本刀只造护栏，删除刀是后继独立 PR，且必须附 runbook §7 的四项准入凭据。
- **不宣称**本套件挂进 CI required check：依赖本机 Chrome + 本地 Vite，不满足门禁准入三问的「零外部依赖」，因此是删除刀 PR 的人工准入闸门。
- **不宣称**覆盖生产 `AgentSideRail.vue` 的完整 PC dock 布局、像素外观或移动端形态。fixture 页的 `.pc-dock-shell` 是固定容器壳；被保护的是 `components/agent/presentation/` 组件链的渲染形状（由真实 `AgentPresentationHost.vue` 挂载保证）。
- **不宣称**零环境依赖：需要本机 headless Chrome、受管常驻的 Vite 服务，且本机 HTTP 代理必须绕过（`--no-proxy-server`）；这三点已写进 runbook §3 / §5。
- 全量 `spec-figures` 的 2 个 warning 为历史文档既有，本刀未触碰该文件。

## 7. 完成定义核对

T1–T4 全绿、10 新增 + 1 只追加、负向自检通过、行为级 M11 证明护栏可失败。CI 三必需、squash 合并、合并树逐路径 + 全树 blob sha 核对、`Issue #755` P2 打勾，属于入库阶段，结论登记在 PR 与当日工作日志。
