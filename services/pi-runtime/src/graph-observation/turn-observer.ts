/**
 * 「这一轮该不该画图 / 画了没有」的轮级观测器（spec §6 D1-1）。
 *
 * ⚠️ 为什么必须是**轮级**而不是「查落库」：
 *   `AgentMessage.metadata` 只在**调用真的发生**时才写，
 *   而「该画没画」恰恰是**没调用** ⇒ 落库里根本没有那一行。
 *   这是当前最大的观测盲区，本文件是补它的唯一手段（观测点必须在事件流上）。
 *
 * ⚠️ 为什么信号分「用户 / 模型」两个来源：
 *   中文里「图片 / 图表」无处不在，裸「图」在模型自述里几乎必然命中
 *   ⇒ 混在一起会把触发率稀释成噪声。分开后能回答「是用户明确要图，还是模型自己想画」。
 */
import {
	GRAPH_SIGNAL_WORDS,
	GRAPH_SIGNAL_WORDS_ASSIST,
	isKnownViewName,
	isLegacyViewName,
	type GraphMetrics,
} from "./graph-metrics.js";

const DRAW_TOOL = "render_canvas_view";

export type TurnObserverEvent =
	| { kind: "user_text"; text: string }
	| { kind: "text"; text: string }
	| {
			kind: "tool";
			toolName: string;
			/** 只传参数**名**（值可能是用户可控文本，进 label 是注入面）。 */
			paramNames?: string[];
			/** 仅当取值落在已知枚举内时才传（由调用方校验）。 */
			view?: string;
	  }
	| { kind: "turn_end" };

/** 逐块扫描（文本分片到达，需跨块拼接后判定）。 */
export function containsSignal(text: string, words: readonly string[]): boolean {
	return words.some((w) => text.includes(w));
}

export class TurnObserver {
	private buffer = "";
	private userSignaled = false;
	private assistSignaled = false;
	private drew = false;
	/** 画图前见到的第一个非画图工具 —— 只记第一个，避免把后续正常工具全算成绕路。 */
	private detour: string | null = null;

	constructor(private readonly metrics: GraphMetrics) {}

	feed(e: TurnObserverEvent): void {
		if (e.kind === "user_text") {
			if (containsSignal(e.text, GRAPH_SIGNAL_WORDS)) this.userSignaled = true;
			return;
		}
		if (e.kind === "text") {
			this.buffer += e.text;
			if (!this.assistSignaled && containsSignal(this.buffer, GRAPH_SIGNAL_WORDS_ASSIST)) {
				this.assistSignaled = true;
			}
			return;
		}
		if (e.kind === "tool") {
			if (e.toolName === DRAW_TOOL) {
				this.drew = true;
				for (const name of e.paramNames ?? []) this.metrics.observeParam(name);
				if (e.view !== undefined && isKnownViewName(e.view)) {
					this.metrics.observeView(e.view, isLegacyViewName(e.view));
				}
			} else if (!this.drew && this.detour === null) {
				this.detour = e.toolName;
			}
			return;
		}
		this.settle();
	}

	private settle(): void {
		// ⚠️ 绕路只在**真的画了**时才成立：没画图就不存在「绕路到画图」。
		if (this.detour !== null && this.drew) this.metrics.observeDetour(this.detour);
		const signaled = this.userSignaled || this.assistSignaled;
		this.metrics.observeTrigger({
			signaled,
			drew: this.drew,
			...(signaled
				? {
						source:
							this.userSignaled && this.assistSignaled
								? ("both" as const)
								: this.userSignaled
									? ("user" as const)
									: ("assistant" as const),
					}
				: {}),
		});
		this.buffer = "";
		this.userSignaled = false;
		this.assistSignaled = false;
		this.drew = false;
		this.detour = null;
	}
}
