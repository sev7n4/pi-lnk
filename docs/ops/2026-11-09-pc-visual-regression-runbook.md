# PC 会话页自动化视觉回归套件 · 运行手册

> 规格：`docs/superpowers/specs/2026-11-09-pc-visual-regression-harness-design.md`
> 计划：`docs/superpowers/plans/2026-11-09-pc-visual-regression-harness.md`
> 脚本：`scripts/pc-visual-regression.mjs`；静态判据：`scripts/verify-pc-visual-regression.py`
> 定位：**SSE 母规格 Phase 4「删 PC 冗余渲染」刀的准入护栏**，不是 CI 门禁，不连生产。

## 1. 这个套件保护什么、不保护什么

- **保护**：`apps/web/src/components/agent/presentation/` 组件链在 PC 断点下的渲染形状。fixture 页通过本地 Vite 挂载**真实** `AgentPresentationHost.vue`（prose_block / shot_table 两组固定 envelope），因此删除或改坏该目录下的组件会改变 DOM ⇒ `diff_count>0` ⇒ 删除刀被阻断。
- **不保护**：像素外观、移动端形态、生产 `AgentSideRail.vue` 的 PC dock 布局、SSE/网络层。fixture 页里的 `.pc-dock-shell` 是固定宽度的容器壳，只用于给几何一个稳定的父级，**不是**生产侧栏的复制品。
- **不宣称**：本套件**不挂 required check**，不覆盖像素 diff，不覆盖移动端，也不等于删除动作已完成。

## 2. 为什么不挂 CI

沿用「门禁准入三问」＝零外部依赖 / 确定性 / 可失败：本套件必须依赖本机 headless Chrome 与本地 Vite 服务，第一问不满足；把它塞进 CI 只会制造恒绿或被跳过的伪门禁。因此改为**删除刀 PR 的准入闸门**：由人在本机跑出凭据，写进 PR 描述，评审据此判断。

## 3. 准备本地服务

```bash
env -u NODE_OPTIONS ./apps/web/node_modules/.bin/vite \
  --config scripts/fixtures/pc-visual.vite.config.mjs --host 127.0.0.1
```

服务固定在 `127.0.0.1:5199`，root 为 `scripts/fixtures/`；只读仓库既有 `vite` / `@vitejs/plugin-vue` / `vue`，**不新增 npm 依赖**。fixture 页地址：`http://127.0.0.1:5199/pc-visual-page.html`。

⚠️ 本机若存在 HTTP 代理，Chrome 必须绕过（脚本已带 `--no-proxy-server`）；用 `curl` 核验时加 `--noproxy '*'`。

## 4. env SSOT

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `LNKPI_PC_BASE_URL` | ✅ | — | fixture 页 URL，**不含**生产地址 |
| `LNKPI_PC_CDP_PORT` | ✅ | 9224 | 独立 CDP 端口，避开其他 Chrome 实例 |
| `LNKPI_PC_SHOT_DIR` | ✅ | — | 当前快照 JSON 与 PNG 附件输出目录 |
| `LNKPI_PC_BASELINE` | — | `scripts/baselines/pc-visual-baseline.json` | golden 基线，**只读** |
| `LNKPI_PC_FIXTURE_PAGE` | — | `pc-visual-page.html` | 重复 tab 清理的 URL 匹配键 |
| `LNKPI_PC_VIEWPORT_WIDTH` | — | 1440 | browser 级窗口宽 |
| `LNKPI_PC_VIEWPORT_HEIGHT` | — | 900 | browser 级窗口高 |
| `LNKPI_MIN_PC_WIDTH` | — | 767 | PC 断点下限，低于即 FAIL |
| `LNKPI_PC_CHROME` | — | 本机 Chrome 路径 | headless 可执行文件 |

三个必填项任一缺失 ⇒ 抛 `missing required env`、`exit 1`，**在启动任何连接之前**，不访问任何站点。

运行示例：

```bash
env -u NODE_OPTIONS \
  LNKPI_PC_BASE_URL=http://127.0.0.1:5199/pc-visual-page.html \
  LNKPI_PC_CDP_PORT=9224 \
  LNKPI_PC_SHOT_DIR=/tmp/pc-visual-shots \
  node scripts/pc-visual-regression.mjs
```

## 5. PREFLIGHT 三条硬闸门（先于任何采集）

| # | 判据 | 失败行为 |
| --- | --- | --- |
| P1 | browser 级 `Browser.setWindowBounds` 设 1440×900，并用**全新 CDP session** 复核 `innerWidth` | `P1 FAILED: browser-level bounds did not persist`，`exit 1` |
| P2 | `/json/list` 枚举 + `/json/close/` 清理同 fixture URL 的残留 tab，只保留唯一目标 | 残留 >1 即 `P2 FAILED`，`exit 1` |
| P3 | 打开 fixture 页，断言 `innerWidth>=767`、`.pc-dock-shell` 与真实 Host 均已渲染 | 移动端断点或渲染为空即 `P3 FAILED`，`exit 1` |

### 三条取证坑（承接 #4 runbook，同样污染几何快照）

1. **`innerWidth=756`**：756px 会命中移动端断点，采到的是移动壳，形状全变却仍能自洽 ⇒ 必须直接 FAIL，不能静默换判据。
2. **`Emulation.setDeviceMetricsOverride` 是 session-scoped**：只修当前 CDP session，换一个 session 就失效；`#` 生产冒烟已实证。本套件只用 browser 级 `Browser.setWindowBounds`，并在新 session 复核持久性。
3. **`/json/list` 重复 tab 串台**：同 URL 残留多个 tab 时，裸 `list.find` 可能连到旧页面，采到过期 DOM ⇒ 必须枚举后 `/json/close/` 清理并复核。

## 6. 判据与退出码

**运行时判据 4 项**（全部必须 `PASS`，`SKIP` 不计 PASS）：`PREFLIGHT` / `REAL_COMPONENT_RENDER` / `DETERMINISM` / `BASELINE_DIFF`。
**静态判据 7 组**：`python3 scripts/verify-pc-visual-regression.py` 的 V1–V7，只读文本与 JSON，零外部依赖、不起浏览器。

- 采集两次，`sha256` 必须相等 ⇒ `DETERMINISM_OK`；不等即打印 `DETERMINISM_FAIL` 并判 FAIL。
- 与 golden 基线逐路径比较，输出「新增 / 缺失 / 值变化」三类；`diff_count=0` 才 PASS。
- **PNG 只作人工目视附件，不进退出码**（字体、抗锯齿、GPU 让像素不可复现）。
- 全部通过 ⇒ `VERDICT ALL_PASS`、`exit 0`；任一失败 ⇒ `VERDICT HAS_FAILURE`、`exit 1` 并打印前 8 条差异路径。
- 固定性四要素：固定视口、固定 fixture、固定 `force-device-scale-factor=1`、固定等待（`document.fonts.ready` + 两次 `requestAnimationFrame`）；页面 CSS 显式禁用动画与过渡。

窗口设为 1440×900 后实测 `innerWidth=1440`、`innerHeight=757`（headless 窗口占用）；该值由同一 Chrome 版本稳定复现，已纳入基线的 `viewport` 字段。

## 7. 删除刀准入契约（写进 PR 描述，缺一不视为闭环）

删除 `components/agent/presentation/` 下 PC 冗余渲染的 PR，**必须**在描述中附：

1. `VERDICT ALL_PASS`
2. `diff_count=0`
3. 两次采集的 `sha256`（`SHA_A` / `SHA_B`，必须相等）
4. PNG 截图路径（人工目视附件）

并且：**删除刀不得修改 `pc-visual-baseline.json`**，也不得同时修改 fixture / 采集脚本 / verifier。否则 diff 恒空即为伪绿（判据 D）。golden 基线必须先于删除刀独立合入；本套件合入时基线已随本刀入库且此后只读。

## 8. 基线的建立（仅供审计，勿在删除刀重做）

首次建基线时用临时空 seed 跑一次采集，把 `pc-visual-current.json` 复制为 `scripts/baselines/pc-visual-baseline.json`，再用全新 Chrome 进程复跑确认 `diff_count=0`。2026-11-09 实测：`hosts=2 nodes=100`、`elements=101`、`sha256=82d36fe47f22b5410e191e6299a9abebac83429accfc7fbf30baa40be59377b2`，两次运行逐字节一致。

## 9. 变异与负向自检

- `python3 scripts/verify-pc-visual-regression.py` 的 V1–V7 必须全 PASS。
- 变异用例：删 `Browser.setWindowBounds` / 删 `/json/close/` / PREFLIGHT 移到采集之后 / 双跑改单跑 / diff 恒空 / SKIP 计入 PASS / PNG 接进退出码 / 删准入契约 / 锚点只写进注释 / 无关注释对照。
- 负向：`env -u` 去掉三个必填 env ⇒ `exit 1`，且不启动 Chrome、不访问任何站点。
