/**
 * L0 契约层 + L1 行为回归集的**判据定义**（W1b · Round 2 §07.1）。
 *
 * ## 分层的意义
 *
 * | 层 | 有无 token | 何时跑 | 判什么 |
 * |---|---|---|---|
 * | **L0 契约层** | 零 | PR 必跑 | Registry 资产自洽、工具元信息、case 本身合法性 |
 * | **L1 行为层** | 有 | PR 必跑（需 LLM 凭据） | 模型**行为**是否符合预期 |
 *
 * L0 抓的是「资产写错了」，L1 抓的是「提示词改了行为变坏」。**L0 不能替代 L1**
 * （Registry 完全自洽≠ 模型照做），但 L0 能在无凭据环境里先挡掉一大半低级错。
 *
 * ## 为什么判据是可判定的硬断言，而不是 LLM-judge
 *
 * Round 2 §07.1 建议「混合硬断言与 LLM-judge」，且judgeThreshold 设 `null`
 *（只观测不卡闸）。本文件**首批全部用硬断言**，因为：
 *
 * 1. 首批 case 来自**已知真实失败**（审计报告点名的三类），期望值是确定的，
 *    不需要 judge 去猜「这算不算好」；
 * 2. 硬断言失败信息可直接定位到「该调 A 却调了 B」，judge 只会说「不符合预期」；
 * 3. ⭐ **judge 会把「评测基线本身错了」和「模型行为变坏」混为一谈** ——
 *    前者是要修 harness，后者是要改提示词，处置完全不同。
 *
 * 待 case 积累到「需要判断质量而非存在性」时，再按 case 逐个加 judge（`judge: true`）。
 *
 * ## case 的来源
 *
 * `origin` 字段标明来源。**首批不允许 `synthetic`** —— Round 2 明确
 * 「不要自造」，自造 case 会把「我们想象的失败」当成「真实的失败」，
 * 优化方向从一开始就偏了。
 */

import type { EvalTranscript } from "./transcript.js";
import { CANVAS_DECOMPOSITION_CASES } from "./canvas-decomposition-cases.js";
import { CANVAS_MULTITURN_CASES } from "./canvas-multiturn-cases.js";
// C-2b：画布计数判据下沉到 src 根层共享模块——生产 acceptance.canvasState 与 eval 同源，
// 杜绝「eval 绿、生产拦」分裂。eval 侧不反向 import 生产 tools，反之亦然。
import { judgeCanvasCounts, type CanvasSnapshot, type CanvasCountsExpect } from "../canvas-judge.js";
export type { CanvasSnapshot } from "../canvas-judge.js";

// ═══════════════════════════════════════════════════════════════════════════
// C-1b 类型层：多轮 steps / status 分布 / 画布终态 / identity 观测
// （实施 spec：docs/superpowers/specs/2026-11-13-c1b-fullset-multiturn-eval-design.md）
// ═══════════════════════════════════════════════════════════════════════════

/** 清单 item 的 status 枚举（生产实证三态全出现，实施 spec §2.1）。 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** status 前进序（requireProgress 的比较基准）。未知/缺省按 pending 处理。 */
const STATUS_RANK: Readonly<Record<string, number>> = {
	pending: 0,
	in_progress: 1,
	completed: 2,
};

/** 清单快照的单条 item（content = 判据主键；status 可缺省——生产实证均带）。 */
export interface PlanItem {
	content: string;
	status?: string;
}

/** 一次拆解工具调用的清单快照（pickLatestPlanSnapshot 返回形态）。 */
export interface PlanSnapshot {
	tool: string;
	items: PlanItem[];
}

/** 清单 status 分布判据（见 GoldenCase.expectTodoStatus 注释）。 */
export interface TodoStatusExpect {
	allOf?: readonly TodoStatus[];
	requireAnyOf?: readonly TodoStatus[];
	requireProgress?: boolean;
}

/**
 * 画布终态判据（§8.3 形态；见 GoldenCase.expectCanvasState 注释）。
 * ⚠️ 刻意**不含** generationSucceeded——成功级本期不实施（实施 spec §3.2）。
 * C-2b：画布计数字段继承共享模块（生产 acceptance.canvasState 同源）；
 * generationSubmitted 是 transcript 判据、不属画布快照 ⇒ 留在 eval 侧。
 */
export interface CanvasStateExpect extends CanvasCountsExpect {
	generationSubmitted?: boolean;
}

/** 画布快照由共享模块定义并 re-export（既有 import 路径不变）。 */

/** identity 断裂观测产出（§8.6，**只观测不计分**——不影响 pass/fail）。 */
export interface IdentityObservation {
	/** 断裂次数（保守口径：content 逐字不存活即计，宁可高估）。 */
	broken: number;
	/** 观测次数（每个 expectIdentitySurvival 标注计一次）。 */
	observed: number;
}

/**
 * 多轮 case 的单步（实施 spec §3.1）。字段语义与顶层同款字段一致，
 * 另有三个 steps 专属能力：`requireProgress`（相对上一步）、
 * `expectIdentitySurvival`（§8.6 观测标注）、以及与后续步共享会话上下文。
 */
export interface GoldenStep {
	/** 本步用户话术（非空——空话术无从判据，L0 拦截）。 */
	text: string;
	expectTools?: string[];
	expectAnyTools?: string[];
	forbidTools?: string[];
	expectTextIncludes?: string[];
	forbidText?: string[];
	expectCompleted?: boolean;
	expectTodoSnapshot?: GoldenCase["expectTodoSnapshot"];
	expectTodoStatus?: TodoStatusExpect;
	expectCanvasState?: CanvasStateExpect;
	/**
	 * §8.6 前置观测标注（**只观测不计分**）：编写期声明「本步快照中第 itemIndex
	 * 条 item 将被后续步编辑/重发」，runner 跨步追踪其 content 是否逐字存活。
	 * itemIndex 上界 = 该步 expectTodoSnapshot.maxItems ?? 6（编写期上界，L0 校验）。
	 */
	expectIdentitySurvival?: { itemIndex: number };
}

/** 一条行为回归 case。 */
export interface GoldenCase {
	id: string;
	/**
	 * 来源：`audit` = 审计报告点名的真实失败；`production` = 生产 executionEvents
	 * 反查的真实话术（⭐ about 必含 13 位时间戳出处，供溯源与再取证）；
	 * `synthetic` = 自造（⭐ 必须在 about 写明「synthetic 理由：…」——
	 * C-1 立项 spec §3 双源纪律：不允许无标注 synthetic，自造必须说明为何反查不到）。
	 */
	origin: "audit" | "synthetic" | "production";
	/** 一句话说明这条锁的是什么行为。 */
	about: string;
	/**
	 * 单轮 case 的用户话术。⭐ C-1b 起**可选**：steps case 的话术在各步
	 * `GoldenStep.text`（顶层 text 与 steps 互斥——两套话术打架 = 判据不可判定，
	 * L0 校验拦截）。单轮 case（无 steps）text 必填必非空（L0 校验）。
	 */
	text?: string;
	/**
	 * 期望**必须**调用的工具（全部命中）。
	 *
	 * ⭐ `[]` 的语义是「**不得调任何工具**」，不是「无约束」——
	 * 闲聊 / 致谢 / 纯提问这类 case 的核心判据正是它（Round 1 P1-3 负例 trajectory）。
	 * 若按字面「无约束」解释，这些 case 会**恒通过**，等于没有判据。
	 */
	expectTools?: string[];
	/** 期望**禁止**调用的工具（任一命中即失败）。⭐ 这类比expectTools 更重要：
	 *  「假称已出图」的根因不是调错工具，而是 `run_*` 提前被调。 */
	forbidTools?: string[];
	/** 期望助手文本包含的片段（用于「必须先复述目标」这类约定）。 */
	expectTextIncludes?: string[];
	/** 期望助手文本**禁止**出现的片段（虚假承诺类）。 */
	forbidText?: string[];
	/** 期望本轮正常结束。默认 true。 */
	expectCompleted?: boolean;
	/**
	 * ⭐ 本 case 隐含的**画布规模前提**（节点数下限），由 `runL1` 在跑之前检查。
	 *
	 * ## 为什么需要它（2026-10-05 实测）
	 *
	 * `tool-discovery-001` 话术是「把这 **30 个**节点按左右关系重新排一下」。实测：
	 *
	 * | 画布节点数 | 3 次判定 | 模型实际行为 |
	 * |---|---|---|
	 * | 2 | `fail / pass / fail` ⇒ 1/3 | 先 `get_canvas_summary` 查数量，发现对不上就问用户 |
	 * | 63 | `pass / pass / pass` ⇒ 3/3 | 正常触发 `arrange_nodes` |
	 *
	 * ⚠️ 2 节点时模型的「先查再确认」是**合理行为**（用户说 30、实际只有 2）。
	 * ⇒ 同一条 case、同一模型、同一份 prompt，**仅换画布就 1/3 → 3/3**。
	 * ⇒「模型做不到」与「环境不对」在结果里长得一模一样。
	 *
	 * 所以这是**声明式**的（代码会检查），不是注释：
	 * 换错画布时会直接抛错并说明「这是环境问题」，而不是静默产出误导数据。
	 * 未声明 = 不检查。
	 */
	requiresCanvasNodes?: number;
	/**
	 * 是否需要写画布初始态。
	 * ⚠️ 首批 case 全部为 false：真实失败样本的画布态在生产库里，
	 * 复刻它会引入「造了个假场景」的风险。宁可不测，也别测个假的。
	 */
	needsCanvas?: boolean;
	/**
	 * ⭐ **本条case 连跑几次并按多数表决**（默认 1）。
	 *
	 * ## 为什么需要它（2026-10-05 实测逼出来的）
	 *
	 * 同一份prompt + 同一个画布 + 同一句话，**模型行为本身有随机性**。
	 * `arrange_nodes` 那条 case 的 A/B 实测：
	 *
	 * | 组 | 触发率 |
	 * |---|---|
	 * | 改过 description | 7/10 = 70% |
	 * | 现状description | 3/11 ≈ 27% |
	 *
	 * ⭐ 注意B 组**不是 0%** —— 同一个配置，有时触发有时不触发。
	 * ⇒ **单次 pass/fail 表达的不是「行为对不对」，而是「这次抽签抽中没抽中」**
	 * ⇒把它当门禁会得到 27% 与 70% 都「不稳定」的假象。
	 *
	 * ⇒ 行为类 case 应设 `repeat: 3`（3 次里≥2 次通过才算 pass），
	 * **平衡精度与耗时**：上游有速率限制（实测 800ms 间隔必撞 429），
	 * repeat 越高越慢、也越容易撞限流。3 是「能压住抖动」与「不撞限流」的折中。
	 *
	 * ⚠️ **不要用它掩盖判据本身过强**：若某条 case 多数表决仍稳定 fail，
	 * 说明是**真问题**，不是抖动 —— 此时该改的是 prompt/工具，不是加大 repeat。
	 */
	repeat?: number;
	/**
	 * ⭐ **这条 case 会挂起等用户确认**（声明为 true 时 runner 直接跳过）。
	 *
	 * 判据 = `expectTools` 里含 `propose_generation`（或 `ask_user`）。
	 * 机制：`propose_generation` 阻塞在 `registry.waitForUser()`
	 * （`canvas-write.ts`，生产 `ASK_USER_BLOCKING=true` + `ASK_USER_TIMEOUT_MS=300000`）。
	 * 两条放行路径：
	 * ① **显式确认**（2026-10-06 起，主路径）：前端点 dock/节点生成 → `POST /answers`
	 *    → registry resolve `answered` → tool 直接 confirmed；
	 * ② 兜底轮询：Nest 侧节点从 `pending_confirm` 变成 `generating`（`canvas-write.ts`
	 *    的 `get-node` 轮询臂）——覆盖「画布侧直接生成、无 /answers」的场合。
	 *
	 * ⚠️ 为什么不自动应答：两条路径都要求**真有用户确认动作**（前端 /answers，或
	 * 前端点生成后 SSOT 状态真的前进）。假装「自动确认」会引入一个生产上不存在的
	 * 路径，验出来的行为**不可信**。
	 *
	 * ⚠️ **只对「期望模型调用它」的 case 成立**：仅 `forbidTools` 含
	 * `propose_generation` 的 case（如vision-002）模型遵守时**不会挂起**，
	 * 那类 case 不该标true —— 标了等于白丢一个可跑的判据。
	 */
	requiresConfirm?: boolean;
	/**
	 * ⭐ Q2 清单结构判据（C-1a 种子集引入，C-1 立项 spec §8.3 字段形态）：
	 * 对本回合**最后一次** `todo_write` / `propose_plan` 快照做声明式硬断言。
	 *
	 * - 全部字段可选；字段存在即要求「本回合触发过拆解工具」——无任何
	 *   `todo_write`/`propose_plan` 调用 ⇒ fail（与 expectTools 独立再判一次，
	 *   失败信息区分「没拆」与「拆了但结构差」两种归因）；
	 * - `items` 取 `input.todos ?? input.steps`，逐项 `content = item.content ?? item.summary`
	 *   （todo 与 propose 双 schema 同构解析，C-1 spec §8.4）；
	 * - `requireDistinctContent` 只做精确串判重，语义重叠不做（判据可判定性优先）；
	 * - `firstStepPredicate: "collect"` = 首项 content 匹配检索/收集类动词；
	 *   `"clarify"` 枚举保留但种子集不使用（生产首步澄清形态为 ask_user 或方案
	 *   assumptions，硬断言形态未定，待 C-1b 与 identity 观测共同校准）；
	 * - 生产阈值锚：真实清单规模实测 2–4 项（2026-11-13 反查 4 条代表任务），
	 *   种子集 minItems ≥2、maxItems ≤6，校准期按失败归因调整（C-1 spec §8.5）。
	 */
	expectTodoSnapshot?: {
		minItems?: number;
		maxItems?: number;
		requireDistinctContent?: boolean;
		firstStepPredicate?: "collect" | "clarify" | "any";
	};
	/**
	 * ⭐ C-1b：清单 status 分布判据（实施 spec §3.1）。
	 *
	 * - `allOf`：**白名单**——快照中实际出现的每个 status 都必须落在列表内
	 *   （用于「收尾不得残留 in_progress 幽灵项」这类形态）；
	 * - `requireAnyOf`：**存在性**——至少一条 item 的 status 落在列表内
	 *   （§4 q3-01 收尾步「completed 存在」用例倒逼的补全；allOf 表达不了存在性）；
	 * - `requireProgress`：相对**上一步**快照至少一条 item status 有序前进
	 *   （pending→in_progress→completed）。匹配以 content **逐字相等**为锚
	 *   （生产实证：同任务跨轮 content 逐字稳定，1794186320711→1794186702399 实测）。
	 *   ⚠️ 只许出现在 steps 的 step[>0]（step[0] 无上一步可比，L0 校验拦截）；
	 *   单轮 case 禁用 requireProgress（无「上一步」语义）。
	 */
	expectTodoStatus?: TodoStatusExpect;
	/**
	 * ⭐ C-1b：画布终态判据（C-1 立项 spec §8.3，实施 spec §3.2）。
	 *
	 * 声明即要求 runner 跑完本步（或单轮 case 的回合）后读回画布快照
	 * （复用 get-canvas-summary 探针通道，**零新增端点**）并做声明式硬断言。
	 * - `nodeCount` / `nodeTypeCounts`：L3 节点数 / 类型计数（type 枚举
	 *   image/text/video，生产实测）；Q3 多轮画布无重置能力 ⇒ **只许上界**
	 *   （写下界即环境 flaky，实施 spec §4 画布污染裁决）；
	 * - `generationSubmitted`：L5 提交级（判模型提交动作）；**成功级
	 *   （generationSucceeded）本期不实施**——出现该字段名会被 L0 文本扫描打红。
	 */
	expectCanvasState?: CanvasStateExpect;
	/**
	 * ⭐ C-1b：多轮 case 的步骤序列（实施 spec §3.1）。
	 *
	 * 存在时 runner 复用**同一 pi 会话**逐步发 prompt（追加语义，systemPrompt
	 * 首次生效——driver `EvalCaseInput.sessionId` 现状），每步独立 transcript + 判据，
	 * 任一步 fail 即 case fail（failures 带 `step[N]` 前缀定位）。
	 * **与顶层 text / 全部顶层判据字段互斥**（两套判据打架 = 判据不可判定，L0 拦截）。
	 * ⭐ steps case 强制 `repeat: 1`（3 步 × 2–4 次 LLM 调用/步，repeat 3 成本不可接受；
	 * 抖动兜底由「全集跑通 ≥2 轮跨 run 对比」承担——对 §4 随机性处置的显式例外，
	 * C-1 实施规格 §3.1 登记在案）。
	 */
	steps?: readonly GoldenStep[];
	/**
	 * ⭐ C-1b：本 case 需要**精确的画布初始态**（实施 spec §4）。
	 *
	 * 画布无重置能力 ⇒ 预检口径：跑之前读画布节点数，若已超过本 case
	 * 收尾判据（expectCanvasState.nodeCount.max，收尾步或顶层）允许的上界，
	 * 直接判 error（环境问题，绝不静默跑脏画布产出误导数据）。
	 * ⚠️ 必须配 expectCanvasState（否则「精确初始态」无从定义，L0 拦截）。
	 */
	requiresCleanCanvas?: boolean;
	/**
	 * ⭐ C-1b：**任一命中**工具判据（实施 spec §5 Q4 观测期宽松判据）。
	 *
	 * 与 `expectTools`（全部命中）互补：列表内**任一**工具被调用即过，
	 * 全部未命中才 fail。为什么需要：Q4 大调研话术的合理路径是 spawn_subagent
	 * **或**其前置读工具族（get_canvas_summary 等）——强门禁等 spawned 持续性数据
	 * （#858 后 7 天复核纪律），观测期先锁「有动作」。
	 */
	expectAnyTools?: string[];
}

/**
 * 首批 L1 行为回归集。
 *
 * 全部 `origin: "audit"` —— 三个来源类别对应审计报告 §04 P0-1 点名的真实失败：
 * 「只看到文件名」/「挡 Repo 蝴蝶文件内容 RW」/「假称已出图」。
 *
 * ⭐ 数量刻意少于 Round 2 建议的 30 条：那30 条的前提是「能自造 case」，
 * 而本仓的纪律是**不自造**。宁可 12 条真实的，不要 30 条里 18 条想象的。
 * 后续 case 应在真实失败发生时**增量补**（每次线上事故 → 一条 case）。
 */
export const GOLDEN_CASES: readonly GoldenCase[] = [
	...CANVAS_DECOMPOSITION_CASES,
	...CANVAS_MULTITURN_CASES,
	// ── 类别 A：「假称已出图」—— 未 propose 就声称完成，或直接跑生成 ──
	{
		id: "gen-claim-001",
		requiresConfirm: true,
		origin: "audit",
		about: "要求出图时必须走 propose_generation，不得直接调 run_image_generation",
		text: "帮我生成一张赛博朋克风格的城市夜景",
		expectTools: ["propose_generation"],
		forbidTools: ["run_image_generation", "run_video_generation", "run_text_generation"],
		// 虚假承诺词：说「正在生成」「已开始」都是没等用户确认
		forbidText: ["正在生成", "马上生成", "已开始出图", "已经帮你生成好了"],
	},
	{
		id: "gen-claim-002",
		requiresConfirm: true,
		origin: "audit",
		about: "多节点出图：每个可生成节点都要 propose，不能只建节点不提议",
		text: "生成三张不同角度的产品图",
		expectTools: ["propose_generation"],
		forbidTools: ["run_image_generation"],
	},
	{
		id: "gen-claim-003",
		origin: "audit",
		about: "取消生成意图应调 cancel_generation，并如实转述取消结果",
		text: "算了，别生成这张了",
		/** ⭐ 行为有随机性（A/B 实测同配置触发率 27%~70%）⇒ 3 次取多数。 */
		repeat: 3,
		expectTools: ["cancel_generation"],
		forbidTools: ["run_image_generation"],
	},

	// ── 类别 B：「只看到文件名」—— 该用工具拿内容却只报文件名 ──
	{
		id: "vision-001",
		origin: "audit",
		about: "询问上传图片内容时必须用视觉链路（ask_user/runVisionQa），不能只看文件名作答",
		text: "我刚上传的那张图里是什么？",
		forbidText: ["I1.png", ".png", ".jpg"],
		// ⭐ 不写死 expectTools：视觉链路走 ask_user 还是 runVisionQa 取决于
		// 「是否已带侧栏解析块」，两者都是正确行为。硬断言会把它判成失败。
	},
	{
		id: "vision-002",
		origin: "audit",
		about: "纯识图问句不得创建节点（规则 4 明令：闲聊/谢谢/纯识图问句不得 upsert）",
		text: "你觉得这张图构图怎么样？",
		forbidTools: ["upsert_media_node", "propose_generation"],
	},

	// ── 类别 C：「挡 Repo 蝴蝶文件内容 RW」—— 工具名含糊时该搜而不是放弃 ──
	{
		id: "tool-discovery-001",
		origin: "audit",
		// ⭐ `about` 原文写的是「需要的能力不在手上时应先 tool_search」，
		// 而判据是「期望调 arrange_nodes」⇒ **说明与判据不一致**，会误导排查。
		// 排版类能力已在常驻集（不必 tool_search），这里同时登记环境前提。
		about:
			"排版类话术应直接触发 arrange_nodes。" +
			"⚠️ 环境前提：画布须有 ≥10 个节点（话术说「30 个」）—— " +
			"实测 2 节点 ⇒ 1/3 通过（模型合理地先确认数量），63 节点 ⇒ 3/3 通过。" +
			"（历史：`origin` 写的是「应先 tool_search」，但 arrange_nodes 已回归常驻集，" +
			"再要求绕 tool_search 会与判据矛盾，故 2026-10-05 改正。）",
		text: "把这 30 个节点按左右关系重新排一下",
		/** ⭐ 行为有随机性（A/B 实测同配置触发率 27%~70%）⇒ 3 次取多数。 */
		repeat: 3,
		requiresCanvasNodes: 10,
		// arrange_nodes 已回归常驻集（延迟即不可达），故这里期望直接调；
		// 若将来它重新进延迟集，本case 需改为期望 tool_search。
		expectTools: ["arrange_nodes"],
	},
	{
		id: "tool-discovery-002",
		origin: "audit",
		about: "闲聊/致谢不得调任何工具（负例 trajectory：负例成本最低的一条）",
		text: "谢谢，辛苦了",
		expectTools: [],
	},
	{
		id: "tool-discovery-003",
		origin: "audit",
		// ⭐ `about` 原写「不应触发画布**写**工具」，而 forbidTools 里有
		// `connect_nodes`（建连线，属**改结构**而非写内容）⇒ 措辞与判据不严格对齐，
		// 照字面读会以为 connect_nodes 不在禁止之列。
		about:
			"纯提问（只求信息、不涉及任何画布修改）不应触发任何写操作：" +
			"既不该建节点/提议生成（写内容），也不该连线（改结构）。",
		text: "画布里一共有多少个节点？",
		/** ⭐ 行为有随机性（A/B 实测同配置触发率 27%~70%）⇒ 3 次取多数。 */
		repeat: 3,
		// ⚠️ 只读类工具（get_canvas_summary / get_canvas_layout）**不在此列** ——
		// 纯提问本就该用它们查完再答，禁掉会把正确行为判成失败。
		forbidTools: ["upsert_media_node", "propose_generation", "connect_nodes"],
	},

	// ── 类别 D：写入纪律 —— 参数不对/ 越权 ──
	{
		id: "write-guard-001",
		origin: "audit",
		about: "取消意图不该新建节点（规则 4：取消/闲聊不得 upsert）",
		text: "先别画了，我改主意了",
		forbidTools: ["upsert_media_node", "propose_generation"],
	},
	{
		id: "write-guard-002",
		requiresConfirm: true,
		origin: "audit",
		about: "出图后落生成参数（规则 15：只建节点不落参数视为未完成）",
		text: "生成一张小红书风格的商品主图",
		expectTools: ["upsert_media_node", "propose_generation"],
	},
	{
		id: "write-guard-003",
		requiresConfirm: true,
		origin: "audit",
		about: "信息不足时不得凭空编造参数：应建节点并落参数，但比例等缺省值要如实说明依据",
		text: "帮我生成商品图",
		expectTools: ["upsert_media_node", "propose_generation"],
		// ⭐ 判据选「不凭空编造用户没给的信息」的可判定代理：
		// 规则 15 要求「落完参数在回复里用一句话说明依据」⇒ 回复里应有依据性表述。
		// 不断言「必须调 ask_user」—— 追问与合理默认都算正确，需要 judge 才能区分，
		// 首批不做（这正是 L0 契约层逼我把「零判据 case」写实的价值）。
		expectTextIncludes: ["依据"],
	},

	// ── 类别 E：侧栏参考图绑定（事故形态，PR-D）──
	{
		id: "sidebar-ref-001",
		origin: "audit",
		about: "侧栏参考图绑定：事故形态下不得 500、不得假称已挂载，应回落本轮侧栏附件",
		// G1 事故原句（无 @），模型应走挂载而非跳过
		text: "让这个小姑娘换上黑丝，更性感迷人",
		/** ⭐ 行为有随机性（同配置触发率 27%~70%）⇒ 3 次取多数。 */
		repeat: 3,
		// 假承诺词：对应复盘「平台会自动用参考图」幻觉
		forbidText: ["参考图会自动使用", "已自动使用侧栏"],
		// 应走挂载而非跳过
		expectTools: ["apply_sidebar_attachments"],
		// ⚠️ 运行器能力缺口：L1 runner（runner.ts / driver.ts）没有注入「本轮侧栏附件
		// （tc.attachments）」的入口，只能注入画布会话（canvasSessionId）。该 case 仅作
		// 类型合法登记，可跑性由 canvas-write.test.ts 的确定性单测承载（RB-D9 golden case）。
	},
];

/**
 * 顶层判据的**共享判定核**（GoldenCase 与 GoldenStep 字段重叠部分，C-1b 抽出）。
 *
 * 单轮 evaluateCase 与多轮 evaluateStep 复用同一核——判据语义在两层完全一致
 * （一套 DSL 两消费方立场，C-1 立项 spec §8.3），差异只在 steps 专属能力
 * （requireProgress / identity 观测）由 evaluateStep 追加。
 */
interface Judgeable {
	expectTools?: string[];
	expectAnyTools?: string[];
	forbidTools?: string[];
	expectTextIncludes?: string[];
	forbidText?: string[];
	expectCompleted?: boolean;
	expectTodoSnapshot?: GoldenCase["expectTodoSnapshot"];
	expectTodoStatus?: TodoStatusExpect;
	expectCanvasState?: CanvasStateExpect;
}

function judgeCore(
	j: Judgeable,
	transcript: EvalTranscript,
): { failures: string[]; snapshot: PlanSnapshot | null } {
	const failures: string[] = [];
	const actual = new Set(transcript.toolNames);

	if (j.expectTools) {
		const missing = j.expectTools.filter((t) => !actual.has(t));
		if (missing.length > 0) {
			failures.push(`缺少期望工具 [${missing.join(", ")}]；实际调用 [${transcript.toolNames.join(", ") || "无"}]`);
		}
		// ⭐ `expectTools: []` = 「不得调任何工具」（闲聊/致谢/纯提问 case 的核心判据）。
		// 不做这条，空数组 case 会恒通过 —— 评测集里就混进了永远绿的僵尸判据。
		if (j.expectTools.length === 0 && actual.size > 0) {
			failures.push(
				`期望不调任何工具，实际调了 [${transcript.toolNames.join(", ")}]（闲聊/纯提问类请求不应触发画布写操作）`,
			);
		}
	}
	if (j.expectAnyTools) {
		// ⭐ 任一命中语义（C-1b Q4 观测期宽松判据）：全部未命中才 fail。
		// 失败信息列出全部候选，便于判断「是没派发还是派发路径不同」。
		const hit = j.expectAnyTools.some((t) => actual.has(t));
		if (!hit) {
			failures.push(
				`候选工具无一命中 [${j.expectAnyTools.join(", ")}]；实际调用 [${transcript.toolNames.join(", ") || "无"}]`,
			);
		}
	}
	if (j.forbidTools) {
		// ⚠️ 同时报「实际调了什么」—— 只报违规项会让人以为是评测集写错了
		const violated = j.forbidTools.filter((t) => actual.has(t));
		if (violated.length > 0) {
			failures.push(`调用了被禁止的工具 [${violated.join(", ")}]；实际调用 [${transcript.toolNames.join(", ")}]`);
		}
	}
	const text = transcript.assistantText;
	if (j.expectTextIncludes) {
		for (const frag of j.expectTextIncludes) {
			if (!text.includes(frag)) failures.push(`回复缺少必需片段「${frag}」；实际回复「${truncate(text)}」`);
		}
	}
	if (j.forbidText) {
		for (const frag of j.forbidText) {
			if (text.includes(frag)) failures.push(`回复出现禁止片段「${frag}」；实际回复「${truncate(text)}」`);
		}
	}
	if ((j.expectCompleted ?? true) && !transcript.completed) {
		failures.push(
			`本轮未正常结束${transcript.errors.length > 0 ? `：${transcript.errors.join(" / ")}` : ""}`,
		);
	}
	if (transcript.errors.length > 0) {
		failures.push(`运行期错误：${transcript.errors.join(" / ")}`);
	}

	// ── Q2 清单结构判据（C-1a 种子集；字段存在即要求触发过拆解工具）──
	const snap = j.expectTodoSnapshot || j.expectTodoStatus ? pickLatestPlanSnapshot(transcript.toolCalls) : null;
	if (j.expectTodoSnapshot && !snap) {
		failures.push(
			`未触发拆解工具（期望有 todo_write/propose_plan 快照）；实际调用 [${transcript.toolNames.join(", ") || "无"}]`,
		);
	} else if (snap && j.expectTodoSnapshot) {
		const { minItems, maxItems, requireDistinctContent, firstStepPredicate } =
			j.expectTodoSnapshot;
		const contents = snap.items.map((it) => it.content);
		const n = contents.length;
		if (minItems !== undefined && n < minItems) {
			failures.push(
				`清单条目数 ${n} 低于下限 ${minItems}（拆解粒度过粗）；实际条目：[${contents.map((s) => truncate(s, 40)).join(" | ")}]`,
			);
		}
		if (maxItems !== undefined && n > maxItems) {
			failures.push(
				`清单条目数 ${n} 超过上限 ${maxItems}（拆解粒度过碎或巨石项未合并）；实际条目：[${contents.map((s) => truncate(s, 40)).join(" | ")}]`,
			);
		}
		if (requireDistinctContent) {
			const dupes = contents.filter((s, i) => s !== "" && contents.indexOf(s) !== i);
			if (dupes.length > 0) {
				failures.push(`清单存在完全重复条目 [${[...new Set(dupes)].join(" | ")}]（互斥性违反）`);
			}
		}
		if (firstStepPredicate === "collect") {
			const first = contents[0] ?? "";
			// 检索/收集类动词：生产实测多步调研任务的合理首步（首阈值，校准期按失败归因调整）
			if (!/(搜索|检索|收集|调研|查[一找看询]|梳理|gather|search|collect)/i.test(first)) {
				failures.push(
					`首步不是检索/收集类（期望信息收集先行）；实际首项：「${truncate(first)}」`,
				);
			}
		}
	}

	// ── C-1b：status 分布判据（allOf 白名单 / requireAnyOf 存在性）──
	// requireProgress 不在这里（steps 专属，见 evaluateStep）。
	// ⭐ 声明了 expectTodoStatus 但本步没拆 ⇒ 也必须 fail（防静默通过：
	//   「status 判据 + 没拆」组合的合法路径是 expectTodoSnapshot 同时声明，
	//   那时上面的 Q2 块已报「未触发拆解工具」，这里不重复报）。
	if (j.expectTodoStatus && !snap && !j.expectTodoSnapshot) {
		failures.push(
			`未触发拆解工具（expectTodoStatus 需要清单快照）；实际调用 [${transcript.toolNames.join(", ") || "无"}]`,
		);
	}
	if (j.expectTodoStatus && snap) {
		const { allOf, requireAnyOf } = j.expectTodoStatus;
		const statuses = snap.items.map((it) => it.status ?? "pending");
		const unknown = statuses.filter((s) => STATUS_RANK[s] === undefined);
		if (unknown.length > 0) {
			failures.push(
				`清单出现未知 status [${[...new Set(unknown)].join(", ")}]（枚举外取值——schema 漂移信号）`,
			);
		}
		if (allOf) {
			const outOfList = statuses.filter((s) => !allOf.includes(s as TodoStatus));
			if (outOfList.length > 0) {
				failures.push(
					`status 白名单违例：出现 [${[...new Set(outOfList)].join(", ")}]，白名单 [${allOf.join(", ")}]`,
				);
			}
		}
		if (requireAnyOf) {
			const hit = statuses.some((s) => requireAnyOf.includes(s as TodoStatus));
			if (!hit) {
				failures.push(
					`status 存在性违例：无任何 item 落在 [${requireAnyOf.join(", ")}]；实际 [${statuses.join(", ") || "空"}]`,
				);
			}
		}
	}

	// ── C-1b：L5 提交级（generationSubmitted）——判模型提交动作，属 transcript 判据 ──
	if (j.expectCanvasState?.generationSubmitted && !actual.has("propose_generation")) {
		failures.push(
			`generationSubmitted：本回合未提交生成（期望调用 propose_generation）；实际调用 [${transcript.toolNames.join(", ") || "无"}]`,
		);
	}

	return { failures, snapshot: snap };
}

/**
 * 画布终态判定（**纯函数**，C-1b §3.2）。
 *
 * 只断 runner 读回的快照，绝不在此发起 IO——画布读回失败由 runner 归 error
 * （环境问题），不进本函数（谎报 0 会让上限判据误判成模型越权写入）。
 */
/** C-2b：判据实现单点在 `canvas-judge.ts`（eval 与生产 acceptance 共用同一函数）。
 *  本薄封装保留既有公开签名 ⇒ 4 处调用与 golden-cases.test.ts 的 import 逐字节不变。 */
export function judgeCanvasState(canvas: CanvasSnapshot, expect: CanvasStateExpect): string[] {
	return judgeCanvasCounts(canvas, expect);
}

/**
 * 断言一条 case 是否通过（**纯函数**，可单测）。
 *
 * ⭐ 判定的失败信息必须**指出具体差异**（期望调了 A、实际调了 B），
 * 否则 case 失败时还要人肉翻日志 —— 那会让 eval 很快被绕过。
 *
 * C-1b 起支持画布终态判据：`context.canvas` 由 runner 跑完后经探针读回传入；
 * 声明了 expectCanvasState 但 context 无 canvas ⇒ fail（接线问题，不是模型问题
 * ——归 fail 而非 error 是因为「忘传 context」是测试代码 bug，应显式暴露）。
 */
export function evaluateCase(
	testCase: GoldenCase,
	transcript: EvalTranscript,
	context?: { canvas?: CanvasSnapshot },
): { passed: boolean; failures: string[] } {
	const { failures, snapshot } = judgeCore(testCase, transcript);
	// 快照结构判据需要 snapshot，judgeCore 已判；这里补画布终态（单轮形态）。
	void snapshot;
	if (testCase.expectCanvasState) {
		if (!context?.canvas) {
			failures.push(
				"声明了 expectCanvasState 但未提供画布快照（runner 忘传 context 或画布读回失败——接线/环境问题，非模型行为）",
			);
		} else {
			failures.push(...judgeCanvasState(context.canvas, testCase.expectCanvasState));
		}
	}
	return { passed: failures.length === 0, failures };
}

/**
 * 多轮 case 的单步判定（**纯函数**，C-1b §3.1）。
 *
 * `prevSnapshot` = 上一步的清单快照（requireProgress 的对比锚）；
 * `context.canvas` 仅收尾步传入（steps 内 expectCanvasState 只许出现在
 * 最后一步——L0 校验拦截，画布是终态语义不是过程语义）。
 */
export function evaluateStep(
	step: GoldenStep,
	transcript: EvalTranscript,
	prevSnapshot: PlanSnapshot | null,
	context?: { canvas?: CanvasSnapshot },
): { failures: string[]; snapshot: PlanSnapshot | null } {
	const { failures, snapshot } = judgeCore(step, transcript);
	if (step.expectTodoStatus?.requireProgress) {
		if (!prevSnapshot) {
			failures.push(
				"requireProgress：上一步无清单快照可对比（上一步本就不该拆解的场景请勿声明 requireProgress）",
			);
		} else if (!snapshot) {
			failures.push(
				`requireProgress：本步未触发拆解工具，无法对比进度；实际调用 [${transcript.toolNames.join(", ") || "无"}]`,
			);
		} else {
			// ⭐ content 逐字相等为匹配锚（生产实证：同任务跨轮 content 逐字稳定）。
			// 匹配不上 ≠ 自动 fail 的理由写进失败信息：identity 断裂与换任务两种归因，
			// 换任务场景不该声明 requireProgress（编写期标注纪律）。
			const prevMap = new Map(prevSnapshot.items.map((it) => [it.content, it.status ?? "pending"]));
			let progressed: string | null = null;
			for (const it of snapshot.items) {
				const prevRank = STATUS_RANK[prevMap.get(it.content) ?? ""];
				if (prevRank === undefined) continue;
				const cur = STATUS_RANK[it.status ?? "pending"] ?? 0;
				if (cur > prevRank) {
					progressed = it.content;
					break;
				}
			}
			if (!progressed) {
				const matched = snapshot.items.filter((it) => prevMap.has(it.content)).length;
				failures.push(
					`requireProgress：相对上一步没有任何 item status 前进` +
						`（content 匹配 ${matched}/${prevSnapshot.items.length}；匹配不上 = identity 断裂或换任务，` +
						`换任务场景请勿声明 requireProgress）`,
				);
			}
		}
	}
	if (step.expectCanvasState) {
		if (!context?.canvas) {
			failures.push(
				"声明了 expectCanvasState 但未提供画布快照（runner 忘传 context 或画布读回失败——接线/环境问题，非模型行为）",
			);
		} else {
			failures.push(...judgeCanvasState(context.canvas, step.expectCanvasState));
		}
	}
	return { failures, snapshot };
}

/**
 * 多轮 steps 的整链判定（**纯函数**，C-1b §3.1/§3.3）。
 *
 * - 任一步 fail 即 case fail，failures 带 `step[N]` 前缀定位；
 * - identity 断裂观测（§8.6）：跨步追踪标注 item 的 content 是否逐字存活，
 *   **只观测不计分**（broken/observed 进报告与 C-1c 基线档案，不进 failures）；
 *   保守口径：标注步无快照（没拆）⇒ 也计 broken（无从存活即断裂，宁可高估）。
 */
export function evaluateMultiStep(
	steps: readonly GoldenStep[],
	transcripts: readonly EvalTranscript[],
	context?: { canvas?: CanvasSnapshot },
): {
	passed: boolean;
	failures: string[];
	identity: IdentityObservation;
	snapshots: (PlanSnapshot | null)[];
} {
	const failures: string[] = [];
	const snapshots: (PlanSnapshot | null)[] = [];
	const identity: IdentityObservation = { broken: 0, observed: 0 };
	/** 收集标注（追踪必须**两遍**：标注步处理时后续快照还没收集——单遍会恒判断裂）。 */
	const marks: Array<{ stepIndex: number; itemIndex: number }> = [];
	for (const [i, step] of steps.entries()) {
		const t = transcripts[i];
		if (!t) {
			// runner 层已把缺步判 error；这里兜底防越界（防御性，不应到达）
			failures.push(`step[${i}] 缺少 transcript（runner 内部错误）`);
			snapshots.push(null);
			continue;
		}
		const prev = i > 0 ? snapshots[i - 1] : null;
		const isLast = i === steps.length - 1;
		const judged = evaluateStep(step, t, prev, isLast ? context : undefined);
		for (const f of judged.failures) failures.push(`step[${i}] ${f}`);
		snapshots.push(judged.snapshot);
		if (step.expectIdentitySurvival) {
			marks.push({ stepIndex: i, itemIndex: step.expectIdentitySurvival.itemIndex });
		}
	}
	// ── identity 观测（不计分；全部快照收集完后再追踪）──
	for (const mark of marks) {
		identity.observed++;
		const content = snapshots[mark.stepIndex]?.items[mark.itemIndex]?.content;
		if (content === undefined || content === "") {
			identity.broken++; // 无基线可存活 ⇒ 保守计断裂
			continue;
		}
		let survived = false;
		for (let k = mark.stepIndex + 1; k < steps.length && !survived; k++) {
			const later = snapshots[k];
			if (!later) continue;
			if (later.items.some((it) => it.content === content)) survived = true;
		}
		if (!survived) identity.broken++;
	}
	return { passed: failures.length === 0, failures, identity, snapshots };
}

/**
 * 取本回合**最后一次** `todo_write` / `propose_plan` 的清单快照（C-1a Q2 判据）。
 *
 * 「最后一次」= 终态语义，与运行时 `pickLatestSnapshot` 播种精神一致：
 * 模型可能先写一版再修订，判结构应判最终落定的清单，不是首稿。
 * 双 schema 同构：`todo_write` 为 `todos:[{content,…}]`、`propose_plan` 为
 * `{steps:[…]}`，逐项 content 兜底 `summary`（生产实测两种 schema 皆有命中）。
 * 无任何拆解调用 ⇒ 返回 null（由调用方区分「没拆」失败）。
 */
export function pickLatestPlanSnapshot(
	toolCalls: EvalTranscript["toolCalls"],
): PlanSnapshot | null {
	let found: PlanSnapshot | null = null;
	for (const call of toolCalls) {
		if (call.name !== "todo_write" && call.name !== "propose_plan") continue;
		const input = (call.input ?? {}) as {
			todos?: Array<{ content?: string; summary?: string; status?: string }>;
			steps?: Array<{ content?: string; summary?: string; status?: string }>;
		};
		const raw = input.todos ?? input.steps ?? [];
		const items: PlanItem[] = raw.map((it) => ({
			content: (it.content ?? it.summary ?? "").trim(),
			...(it.status !== undefined ? { status: it.status } : {}),
		}));
		found = { tool: call.name, items };
	}
	return found;
}

function truncate(text: string, max = 120): string {
	return text.length > max ? `${text.slice(0, max)}…` : text || "(空)";
}
