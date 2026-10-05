# 本阶段的告警规则**刻意为空**（`rules/` 目录保留但不放入 .yml）
#
# ## 为什么不启用
#
# spec §7.2 写明阶段四的前置是：
#
#   > **必须先有 ≥1 个发布周期的真实指标，才能校准 spec §7.2 的初值阈值。**
#
# 实测（2026-10-05）：pi-runtime pod 刚随 #192 部署重启，**指标计数全部归零**。
# 在这个时刻启用规则，得到的会是「零错误率」的假象 —— 而不是真实基线。
#
# 那 6 条规则（5% / 2% / 30s / 660s）全是**初值**，直接启用必然误报：
# - 规则 4（工具错误率 > 2%）：`get_canvas_layout` 等工具的错误率实测远超 2%
#   （**注意**：#192 修好了分类，但 404 本身是真实存在的，见下）
# - 规则 5/6（耗时 p99）：**一个样本都没有**，histogram 的 p99 在样本量 < 100 时无意义
#
# ## 根因已定位并修复（2026-10-05 复核，推翻本节原来的「端点缺失」判断）
#
# 生产实测（#192 修复之前）：`get_canvas_layout` 19 次调用里 15 次错误、`get_canvas_summary` 17 次里 15 次错误。
# #192 修好的是**分类**（404 归 `upstream_4xx` 而不是 `internal`），**不是这些 404 本身**。
#
# ⚠️ 本节原写「`render_canvas_view` 的 Nest 端点在 master 上搜不到 ⇒ 属功能缺陷」。**该判断不成立**：
# - `@Post('get-canvas-layout')` **存在**（`agent-canvas-tools.controller.ts:1299`）
# - `render_canvas_view` **复用**该端点：pi-runtime 侧 `tools/registry.ts:83` 的 `fetchLayout`
#   就是 `client.post("/agent/internal/get-canvas-layout", {sessionId})`；
#   它只读不写（`render-canvas-view.ts` 文件头：只调 fetchLayout，不 POST 任何 Nest 写端点），
#   SVG 由 pi-runtime **本地**渲染（`render-canvas-view.views.ts`）⇒ **它不需要自有路由**。
#   原来按 `render-canvas-view` 这个路由名去搜，**搜不到 ≠ 端点缺失**。
#
# ⇒ 这些 404 是**单一根因**：传给 Nest 的 `sessionId` 是复合串
# （`<画布id>_<pi键>-<hash>-<random>`），`prisma.session.findUnique` 查不到 ⇒ 404「会话不存在」。
# 已在 **#197** 修复（写盘侧补 `canvasSessionId`），当日 14:05 部署上线（tag `99a7440ec`）。
#
# ## 何时启用
#
# 1. 本栈稳定运行 ≥1 个发布周期（Pod 重启一次不影响 Prometheus 里的历史）
# 2. 用真实数据校准 spec §7.2 的 5 个阈值
# 3. 404 根因**已被真实流量验证消除**。
#    ⚠️ 代码侧已修并上线，但截至 2026-10-05 15:40：采集窗口仅约 1.6h（pod 14:05 随 #197 重启，
#    计数器归零）、`pi_runtime_sessions_active` = **0**（近零流量）、
#    `pi_runtime_tool_calls_total` 只有 6 条序列且**全为 `result="ok"`**
#    ⇒ **「没有错误」当前只是「没有流量」的另一种写法，不能据此判定已修好**
#    （正是 spec §7.2 说的窗口校正原则）。
#    判据：在一个**分母非零**的窗口里 `sum(increase(pi_runtime_tool_calls_total{result="error"}[1h]))
#    or vector(0)` 稳定为 0。
#    ⚠️ 原文写的是 `[1d]` 且没带 `or vector(0)` —— **那是一条执行不了的判据**：
#    - 族为空时 `increase(...)` 返回**空向量**而不是 0，「稳定为 0」与「查不到」无法区分；
#    - `[1d]` 会跨越 pod 重启（counter 归零），`increase` 在跨重启窗口上的取值不可信。
#    正确写法必须同时满足三条：① 带 `or vector(0)`；② 窗口时长 < 典型重启间隔；
#    ③ **先确认同一窗口的分母 `sum(increase(pi_runtime_tool_calls_total[1h]))` 非零**，
#    否则「错误为 0」只是「没有事件」的另一种写法。
#    判据与脚本：见同目录 `read-decisions.sh`（把上面这些判据做成了可执行的一次性自检）。
