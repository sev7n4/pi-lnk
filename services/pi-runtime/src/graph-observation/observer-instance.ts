/**
 * 进程级单例：把 `TurnObserver` 接到两个互不相通的对象图上。
 *
 * ⚠️ 为什么必须是单例（而不是挂在 `Metrics` 上逐实例创建）：
 *   一轮的观测需要**两处**喂数据，而这两处拿不到同一个实例 ——
 *     1. `app.ts` 的 `/sessions/:id/prompt` —— 只有这里拿得到**用户问句**
 *        （「该画没画」的分母，落库里没有，见 spec §6 D1-1）；
 *     2. `session-manager.ts` 的 `attachEvents` —— 模型自述文本与 `tool_start`。
 *   `/metrics` 同样是进程级的（单进程单端点），故进程级单例与既有 `/metrics` 语义一致。
 *
 * ⚠️ 状态是**累计计数**，不做跨进程聚合：pi-runtime 单实例部署，
 *   重启即清零 ⇒ 与 `ToolMetrics` 同款取舍（Prometheus 侧按 counter 的 rate 读）。
 */
import { GraphMetrics } from "./graph-metrics.js";
import { TurnObserver } from "./turn-observer.js";

export const graphMetrics = new GraphMetrics();

export const graphTurnObserver = new TurnObserver(graphMetrics);
