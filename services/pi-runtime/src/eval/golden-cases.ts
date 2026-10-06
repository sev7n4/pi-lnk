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

/** 一条行为回归 case。 */
export interface GoldenCase {
	id: string;
	/** 来源：`audit` = 审计报告点名的真实失败；`synthetic` = 自造（首批应为空）。 */
	origin: "audit" | "synthetic";
	/** 一句话说明这条锁的是什么行为。 */
	about: string;
	/** 用户话术。 */
	text: string;
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
];

/**
 * 断言一条 case 是否通过（**纯函数**，可单测）。
 *
 * ⭐ 判定的失败信息必须**指出具体差异**（期望调了 A、实际调了 B），
 * 否则 case 失败时还要人肉翻日志 —— 那会让 eval 很快被绕过。
 */
export function evaluateCase(
	testCase: GoldenCase,
	transcript: EvalTranscript,
): { passed: boolean; failures: string[] } {
	const failures: string[] = [];
	const actual = new Set(transcript.toolNames);

	if (testCase.expectTools) {
		const missing = testCase.expectTools.filter((t) => !actual.has(t));
		if (missing.length > 0) {
			failures.push(`缺少期望工具 [${missing.join(", ")}]；实际调用 [${transcript.toolNames.join(", ") || "无"}]`);
		}
		// ⭐ `expectTools: []` = 「不得调任何工具」（闲聊/致谢/纯提问 case 的核心判据）。
		// 不做这条，空数组 case 会恒通过 —— 评测集里就混进了永远绿的僵尸判据。
		if (testCase.expectTools.length === 0 && actual.size > 0) {
			failures.push(
				`期望不调任何工具，实际调了 [${transcript.toolNames.join(", ")}]（闲聊/纯提问类请求不应触发画布写操作）`,
			);
		}
	}
	if (testCase.forbidTools) {
		// ⚠️ 同时报「实际调了什么」—— 只报违规项会让人以为是评测集写错了
		const violated = testCase.forbidTools.filter((t) => actual.has(t));
		if (violated.length > 0) {
			failures.push(`调用了被禁止的工具 [${violated.join(", ")}]；实际调用 [${transcript.toolNames.join(", ")}]`);
		}
	}
	const text = transcript.assistantText;
	if (testCase.expectTextIncludes) {
		for (const frag of testCase.expectTextIncludes) {
			if (!text.includes(frag)) failures.push(`回复缺少必需片段「${frag}」；实际回复「${truncate(text)}」`);
		}
	}
	if (testCase.forbidText) {
		for (const frag of testCase.forbidText) {
			if (text.includes(frag)) failures.push(`回复出现禁止片段「${frag}」；实际回复「${truncate(text)}」`);
		}
	}
	if ((testCase.expectCompleted ?? true) && !transcript.completed) {
		failures.push(
			`本轮未正常结束${transcript.errors.length > 0 ? `：${transcript.errors.join(" / ")}` : ""}`,
		);
	}
	if (transcript.errors.length > 0) {
		failures.push(`运行期错误：${transcript.errors.join(" / ")}`);
	}

	return { passed: failures.length === 0, failures };
}

function truncate(text: string, max = 120): string {
	return text.length > max ? `${text.slice(0, max)}…` : text || "(空)";
}
