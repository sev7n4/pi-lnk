/**
 * 图形化表达引擎的观测指标（spec `2026-10-08-graph-expression-engine-design.md` §6 D1）。
 *
 * ⚠️ 为什么挂在现有 `Metrics` 的 `lines` 上（不新建指标系统）：
 *   `tool-metrics.ts` 已把 39 个工具的调用/错误/耗时结算进同一个 `/metrics` 文本，
 *   **追加**新族不会改动既有行的字面量 ⇒ 既有回归锁仍然成立。
 *
 * ⚠️ 四个维度各自独立、互不推导：
 *   - signal / drew：这一轮「信号命中但没画」也要记，否则触发率的分母恒为 0
 *     （没调用的记录本来不落库 —— 这是当前最大的观测盲区，见 spec §6 D1-1）；
 *   - view：视图分布（legacy 别名归一后计数），用于评估 G6「模型用对了没有」；
 *   - param：15 个参数各自的显式使用率，回答遗留 L6（哪些参数该删）；
 *   - detour：画图前先调了什么工具，是「token 浪费」的定位依据（取证事实 2）。
 *
 * ⛔ label 取值只来自**代码内的枚举与工具名**，绝不来自用户输入
 * （`title` / 节点标题 / 用户问句一律不进 label）—— 与 `tool-metrics.ts` 的
 * 「`resultText` 绝不可作为 label 渲染」同一条纪律。
 */

/**
 * 判定「这一轮该画图」的信号词（短词，避免把整句塞进 label）。
 *
 * 🔴 **2026-10-08 生产基线实测后改过一次，别改回去。**
 * 初版含裸「图」与「画一个 / 画张」，在生产库 1806 个轮次上实测：
 *   宽松（含裸「图」）：命中 749 / 真画 19 ⇒ **2.5%**
 *   严格（本版）      ：命中 16  / 真画 8  ⇒ **50%**
 * 差 20 倍，原因在于**本产品是生图平台** —— 用户嘴里的「图」绝大多数指
 *「生成一张图片」（「帮我生成一张产品抠图透明底 PNG」「确认出图」），
 * 不是「画一张关系图」。宽松口径 749 条里 38% 直接命中生成类词。
 *
 * ⇒ 裸「图」在本产品线是**反信号**，不是信号。判据改为只认**图形化表达专属**的
 * 多字词；「画一个 / 画张」同理（「画一张产品图」是生成）。
 *
 * ⚠️ 「分布」是这表里最松的一个（「渠道分布」这类问句会被计入），
 *    保留它是因为 spec §3.4 的 matrix 视图确实对应「分布」类问句。
 *    下次取基线时复核它的误报率，误报高就改成「分布图」。
 */
export const GRAPH_SIGNAL_WORDS = [
	"示意图",
	"关系图",
	"流程图",
	"结构图",
	"架构图",
	"思维导图",
	"时序图",
	"依赖图",
	"拓扑",
	"树状",
	"时间线",
	"泳道",
	"矩阵",
	"分布",
	"可视化",
	"梳理成图",
] as const;

/**
 * 模型侧自述文本专用的信号词。
 *
 * ⚠️ 为什么与用户词表**分开维护**而不是复用同一常量：两者当前取值相同，
 * 但衡量的是两件事 —— 用户词表是「用户是否要图」，模型词表是「模型是否认为该画图」。
 * 分开后将来任一侧收窄（例如发现模型爱自言自语「我先看看这张图片」）都不会波及另一侧。
 */
export const GRAPH_SIGNAL_WORDS_ASSIST = GRAPH_SIGNAL_WORDS.filter((w) => w.length >= 2);

/** `render_canvas_view` 的 `view` 实测枚举（7 个，含 2 个 legacy 别名）。 */
export const GRAPH_VIEW_NAMES = [
	"layout",
	"tree",
	"timeline",
	"swimlane",
	"matrix",
	"topology",
	"table",
] as const;

/**
 * view 取值是否已知。
 *
 * ⛔ 只有已知取值才允许进 Prometheus label —— `view` 名义上是枚举，但工具入参在运行时
 * 是模型给的自由文本，直接把值塞进 label 等于把模型输出写进监控面（label 注入面）。
 */
export function isKnownViewName(view: string): boolean {
	return (GRAPH_VIEW_NAMES as readonly string[]).includes(view);
}

/**
 * legacy 视图名 → 规范名。统计必须在**这里**归一，
 * 否则 `topology` 与 `layout+dependency` 会被双计（Review Focus #4）。
 */
const LEGACY_VIEW_ALIAS: Readonly<Record<string, string>> = {
	topology: "layout",
};

export function isLegacyViewName(view: string): boolean {
	return Object.prototype.hasOwnProperty.call(LEGACY_VIEW_ALIAS, view);
}

/** 归一视图名：`topology` → `layout`；其余原样返回（含 `table`，它是独立旧场景不是别名）。 */
export function normalizeViewName(view: string): string {
	return LEGACY_VIEW_ALIAS[view] ?? view;
}

function inc(m: Map<string, number>, k: string, by = 1): void {
	m.set(k, (m.get(k) ?? 0) + by);
}

export class GraphMetrics {
	/** key: 信号来源（user / assistant / both） */
	private signals = new Map<string, number>();
	private drew = 0;
	private views = new Map<string, number>();
	private legacy = 0;
	private params = new Map<string, number>();
	private detours = new Map<string, number>();

	/**
	 * 结算一轮。
	 *
	 * @param signaled 本轮是否命中图形化表达信号
	 * @param drew    本轮是否真的调了画图工具
	 * @param source  信号来自用户问句 / 模型自述 / 两者
	 */
	observeTrigger(o: { signaled: boolean; drew: boolean; source?: "user" | "assistant" | "both" }): void {
		if (o.signaled) inc(this.signals, o.source ?? "unknown");
		if (o.drew) this.drew += 1;
	}

	observeView(view: string, isLegacy: boolean): void {
		// ⛔ 空 view 不进分布：宁可少一条，也不能编造一个 "unknown" 桶
		if (!view) return;
		inc(this.views, normalizeViewName(view));
		if (isLegacy) this.legacy += 1;
	}

	observeParam(name: string): void {
		if (name) inc(this.params, name);
	}

	observeDetour(toolName: string): void {
		if (toolName) inc(this.detours, toolName);
	}

	renderInto(lines: string[]): void {
		lines.push("# HELP pi_runtime_graph_signal_total 图形化表达：命中信号的轮数（按来源分桶）");
		lines.push("# TYPE pi_runtime_graph_signal_total counter");
		for (const [k, v] of this.signals) {
			lines.push(`pi_runtime_graph_signal_total{source="${k}"} ${v}`);
		}
		lines.push("# HELP pi_runtime_graph_drew_total 图形化表达：实际调用画图工具的轮数");
		lines.push("# TYPE pi_runtime_graph_drew_total counter");
		lines.push(`pi_runtime_graph_drew_total ${this.drew}`);
		if (this.views.size > 0) {
			lines.push("# HELP pi_runtime_graph_view_total 视图分布（已归一，legacy 别名并入规范名）");
			lines.push("# TYPE pi_runtime_graph_view_total counter");
			for (const [k, v] of this.views) lines.push(`pi_runtime_graph_view_total{view="${k}"} ${v}`);
		}
		if (this.legacy > 0) {
			lines.push("# HELP pi_runtime_graph_view_legacy_total 用了 legacy 别名（topology/table）的次数");
			lines.push("# TYPE pi_runtime_graph_view_legacy_total counter");
			lines.push(`pi_runtime_graph_view_legacy_total ${this.legacy}`);
		}
		if (this.params.size > 0) {
			lines.push("# HELP pi_runtime_graph_param_total 各参数被显式传入的次数");
			lines.push("# TYPE pi_runtime_graph_param_total counter");
			for (const [k, v] of this.params) lines.push(`pi_runtime_graph_param_total{param="${k}"} ${v}`);
		}
		if (this.detours.size > 0) {
			lines.push("# HELP pi_runtime_graph_detour_total 画图前先调用的其它工具（绕路）");
			lines.push("# TYPE pi_runtime_graph_detour_total counter");
			for (const [k, v] of this.detours) lines.push(`pi_runtime_graph_detour_total{tool="${k}"} ${v}`);
		}
	}
}
