/**
 * 真模型 A/B 场景集（spec §8.2第 2 层）。
 *
 * ⚠️ **不进 CI**：慢 + 烧 token + flaky（spec §8.2 硬约束 2）。
 * 人工发版前跑的完整步骤见 `docs/ops/prompt-ab-runbook.md`。
 * 本文件**只是数据**——不含 runner、不含断言、不被任何生产代码 import。
 *
 * ── 判据设计原则 ──────────────────────────────────────────────
 * `expectTools` 钉的是「模型该调什么工具」，**不是「它说了什么」**。
 * 后者受措辞影响太大，同一条规则换个说法就false，不适合做门禁。
 * 需要判读回复文本的，放`manualJudge` 字段，由人判。
 *
 * ── 为什么 scenarios 不自己校验 anchor ──────────────────────────
 * 本文件是纯数据，anchor 正确性不能靠人review 兜底，已由
 *   `npx tsx scripts/verify-ab-scenarios.ts`
 * 结构校验（**不进 CI**，spec §8.2 硬约束 2；跑法见 runbook）。它断言三件事：
 *   (a) anchor 在其 groups 下可达—— 防「规则没进 prompt，场景空跑」
 *   (b) groups 与生产 ruleGroups（agent.service.ts）一致 —— 防「场景在生产不可达」
 *       偏离项必须显式登记为已知例外，不默默放过
 *   (c) 每个场景至少有一项判据 —— 防「跑它但不产生任何信息量」
 * 另有既有闸门：`prompt-lint.ts`（字符预算 + frontmatter）、`gen-prompt-spec-map.ts --check`。
 *
 * ⚠️ **改规则正文前先看预算余量**：`pnpm prompt:lint` 会报 L6 全组合字符数，
 * 当前 **3194 / 硬线 3200 / 余量仅 6**（预警线 2720 已过）——余量见底，
 * 一次措辞润色就可能顶爆门禁。上面这个数字**不是常驻副本，以实跑输出为唯一权威源**。
 */

/** 会话启用的提示词规则组（= `ruleGroups`，对应 PROMPT_SPEC.md 的 group 语义）。
 *
 *  取值只有三个，来自 loader 的真实分组（`prompt-registry.loader.ts`）：
 *  - `core`：无 group 字段的规则恒注入
 *  - `writeTools`：写工具可用时注入
 *  - `genTools`：生成工具可用时注入
 *
 *  ⚠️ 这不是「工具分组」而是「规则分组」。填错会让对应规则根本不进 prompt，
 *  场景就跑成了测模型裸能力 —— 结论无效。
 */
export type PromptRuleGroup = "core" | "writeTools" | "genTools";

export interface AbScenario {
	/** 场景 id，进报告用 */
	id: string;
	/** 对应哪条规则的 anchor（与 PROMPT_SPEC.md 规则地图逐字一致） */
	anchors: readonly string[];
	/** 规则组：决定哪些规则会进本次 prompt */
	groups: readonly PromptRuleGroup[];
	/** 用户输入 */
	userMessage: string;
	/**
	 * 期望模型调用的工具序列（按序）。
	 * 空数组 = 期望**不调任何工具**（负向边界场景，靠它钉住「不该出手时别出手」）。
	 */
	expectTools: readonly string[];
	/** 期望模型**不**调的工具（防止"顺手多调一个"）。只列关键的，不要求穷举。 */
	forbidTools?: readonly string[];
	/** 人工判读项：需要人读回复文本才能判的（自动判不了） */
	manualJudge?: string;
	/**
	 * 跑本场景前的前置操作（不属于被评测的模型行为，不计入判据）。
	 * 用于「需要先备好画布状态 / 先污染记忆再提问」的场景。
	 *
	 * ⚠️ **凡userMessage 引用了画布既有内容（「这三个镜头」「第二个节点」），setup 就是必需的**——
	 * 缺了会在空画布上跑，模型答「画布上还没有节点」被判失败，
	 * 但那是环境没准备好，与提示词质量无关（假红灯）。
	 */
	setup?: readonly string[];
	/** 备注：写清这个场景在防什么回归 */
	note?: string;
}

/**
 * 场景集，覆盖 spec §8.2 场景表，并按「每条规则至少一个场景」补齐到 9 个 anchor 全覆盖
 * （brief 给了 7 个，漏了 `no-gen-tools` / `readonly-session-guard` / `identity-and-truthfulness`，
 *  其中前两个是「组缺席时才生效」的负向守卫——漏了等于没测只读会话）。
 *
 * 工具名已逐个对照 `services/pi-runtime/src/tools/` 实际注册名校准（见 task-5-report）。
 * ⚠️ 5 个 `run_*_generation` 由 `generation.ts` 的工厂函数 `runTool(name, ...)` 动态生成，
 * **不是 `name: "..."` 字面量** —— 用 `grep 'name: "'` 扫不到，别据此判它们不存在。
 */
export const PROMPT_AB_SCENARIOS: readonly AbScenario[] = [
	{
		id: "gen-need-confirm",
		// gen_tool_policy.md 的 anchor 是 `gen-gate`；no_gen_claim.gen.md 是 `no-gen-claim`
		anchors: ["gen-gate", "no-gen-claim", "media-tool-policy"],
		groups: ["core", "writeTools", "genTools"],
		userMessage: "帮我生成三张赛博朋克风格的城市海报",
		// 规则 4/5：先建节点 → propose_generation；规则 11：确认前禁 run_*
		expectTools: ["upsert_media_node", "propose_generation"],
		forbidTools: ["run_image_generation", "run_video_generation", "run_text_generation"],
		manualJudge: "不得声称「正在生成」「已开始出图」；须等用户确认（规则 3）",
		note: "防「跳过 propose 直接 run_*」。规则 11 的pending_confirm 由系统强制校验，此场景验的是模型有没有主动走确认流程。",
	},
	{
		id: "missing-info-ask",
		anchors: ["media-tool-policy"],
		groups: ["core", "writeTools", "genTools"],
		userMessage: "帮我做这个项目的分镜",
		// media_tool_policy 规则 16：内容类关键信息缺失先调 ask_user
		expectTools: ["ask_user"],
		forbidTools: ["propose_generation"],
		manualJudge: "应问出必要信息（如题材/时长/画幅），而非自行编造完整分镜",
		note: "对应 spec §8.2 表格第 2 行（规则 16）。这是 §8.1 机检测不到、只有真模型能暴露的失败模式。",
	},
	{
		id: "multi-node-view",
		//本场景 groups 无 genTools ⇒ 生效的是 no_gen_claim.nogen.md（`no-gen-tools`，禁止任何 run_*），不是 `no-gen-claim`
		anchors: ["canvas-view-card", "no-gen-tools"],
		groups: ["core", "writeTools"],
		userMessage: "这三个镜头之间是什么关系？",
		setup: [
			"画布上须先有 3 个节点（对应「这三个镜头」）。用 upsert_media_node 建 3 个 image 节点，",
			"标题分别为 镜头1 / 镜头2 / 镜头3，并给每个节点写一句内容描述（如「雨夜街道，霓虹反光」）。",
			"可选：用 connect_nodes 把 3 个节点串成 镜头1 → 镜头2 → 镜头3，",
			"这样「什么关系」才有真实的多节点依赖可渲染。",
			"⚠️ 空画布直接跑 ⇒ 模型答「画布上还没有节点」⇒ expectTools 判失败，",
			"   但那是环境没准备好，与提示词质量无关（假红灯）。",
		],
		// canvas_view_policy 规则 16：涉及 3+ 节点的关系类问题 → render_canvas_view
		expectTools: ["render_canvas_view"],
		forbidTools: ["propose_generation", "run_image_generation"],
		note: "防「关系类问题只给纯文本」。注意本场景 groups 不含 genTools —— 生成工具不可用时本就不该碰生成。",
	},
	{
		id: "single-node-no-view",
		anchors: ["canvas-view-card", "no-gen-tools"],
		groups: ["core", "writeTools"],
		userMessage: "第二个节点标题是什么？",
		setup: [
			"画布上须至少有 2 个节点（对应「第二个节点」）。用 upsert_media_node 建 2 个 image 节点，",
			"标题分别为 镜头1 / 镜头2。",
			"⚠️ 空画布直接跑 ⇒ 模型无节点可答 ⇒ expectTools 空数组虽满足但 manualJudge 无从判读，",
			"   场景退化成空跑（假绿）。",
		],
		// canvas_view_policy 规则 18 负向边界：单节点/单字段纯文本回答，不得出图
		expectTools: [],
		forbidTools: ["render_canvas_view", "propose_generation", "run_image_generation"],
		manualJudge: "纯文本回答，**不得**出图（负向边界）",
		note: "与 multi-node-view 成对：一条钉正边界一条钉负边界，防止规则 16 被过度泛化。",
	},
	{
		id: "no-template-claim",
		// sidebar_vision.tail.md 的 anchor 是 `no-template`（注意没有 `sidebar-vision` 这个anchor）
		// identity-and-truthfulness 在此叠加：规则 14 说「如实说明没有模板能力」，
		// identity 规则 2 说「不得否认平台的图片生成能力」—— 两者必须同时成立
		anchors: ["no-template", "identity-and-truthfulness"],
		groups: ["core", "writeTools"],
		userMessage: "帮我套用一下分镜生成模板",
		expectTools: [],
		forbidTools: ["propose_generation"],
		manualJudge:
			"如实说明没有模板能力，**不虚构模板名**；可用节点+连线搭骨架替代（规则 14）。" +
			"同时**不得**因此否认平台的图片生成能力（identity 规则 2）",
		note: "防虚构能力。规则 14 允许「用节点+连线搭骨架替代」，所以本场景不forbid upsert_media_node。",
	},
	{
		id: "canvas-daily-arrange",
		// canvas_daily_ops.md 的 anchor 是 `canvas-daily-ops`（master #184 新增规则，本 PR 按 L11 补的 anchor）
		// 规则 19：排版必须走 arrange_nodes，且**不要自己算坐标**；排完用 focus_nodes 带入视口
		anchors: ["canvas-daily-ops"],
		groups: ["core", "writeTools", "genTools"],
		userMessage: "帮我把画布上的节点按关系展开排版一下",
		setup: [
			"画布上须至少有 3 个节点，否则 arrange_nodes 无对象、场景退化。",
			"用 upsert_media_node 建 3 个 image 节点（镜头1/2/3）。",
		],
		expectTools: ["arrange_nodes"],
		forbidTools: ["propose_generation", "run_image_generation"],
		manualJudge: "调用 arrange_nodes 排版（可 along_edges 有向展开），**不自己算坐标**、不用 set_node_text 改内容。",
		note:
			"钉#184 规则 19 的正向路径。forbidTools 排除生成类：排版是纯重排，" +
			"模型若顺手 propose_generation 说明把「排版」误读成「重新出图」。",
	},
	{
		id: "canvas-daily-tool-search",
		// canvas_daily_ops 规则 22：工具列表里没有的能力，先 tool_search 搜（勿直接答「做不到」）
		// 这是 #184 的 trigger 词扩展核心，负向边界是「闲聊/道谢不调上述工具」
		anchors: ["canvas-daily-ops"],
		groups: ["core", "writeTools", "genTools"],
		userMessage: "你能把这几个镜头合并成一个九宫格吗",
		expectTools: ["tool_search"],
		forbidTools: ["propose_generation"],
		manualJudge:
			"先 tool_search 按关键词搜（如拼图/九宫格/合成），**不得直接答「做不到」**；" +
			"搜到后按其参数调用，搜不到才如实说明。",
		note:
			"钉#184 规则 22 的 tool_search 触发条件（本题能力不在工具列表里）。" +
			"与 chat-no-node 配对：那条钉「闲聊不调工具」，这条钉「能力缺失先搜」。",
	},
	{
		id: "readonly-session-refuse",
		// write_guard.md 的 anchor 是 `readonly-session-guard`，`unlessGroup: writeTools`
		// ⇒ 本场景 groups 必须**不含 writeTools**，该规则才进prompt（否则场景空跑）
		anchors: ["readonly-session-guard", "identity-and-truthfulness"],
		groups: ["core"],
		// ⚠️ 跑这个场景必须先改 apps/server/src/agent/agent.service.ts 的 ruleGroups 为 ['core']
		//（生产硬编码三组全开，无 env 开关）—— 见 runbook「groups 怎么切」。
		userMessage: "帮我把这三个镜头连成一条线，再给第一个镜头出张图",
		setup: [
			"同multi-node-view：先用 upsert_media_node 建 3 个 image 节点（镜头1/2/3）。",
			"本场景只验「模型是否声明写能力不可用」，不要求画布已有连线。",
		],
		expectTools: [],
		forbidTools: [],
		// ⚠️ forbidTools **故意留空**。resolveToolsWithClient（tools/config.ts:54-68）不接 ruleGroups，
		// 无条件注册全部工具 ⇒ 即使 groups=['core']，写工具的 schema 照样下发给模型。
		// 所以「模型调了connect_nodes」不能判它违反提示词——它照运行时真相行事而已。
		// 把 connect_nodes 等写进 forbidTools 会让本场景变成「要求模型就自身环境说假话」。
		manualJudge:
			"【本场景测的是「模型有没有把 prompt 里的声明说出来」，不是「工具是否真被裁剪」】" +
			"判据 = 以下任一成立即通过：" +
			"(1) 声明「当前会话写工具未开放/ 仅只读」；或" +
			"(2) 明确告知用户在此会话无法获得写能力（换会话/请管理员开权限等）。" +
			"不判「是否真的调了写工具」——工具确实可用（见 forbidTools 注）。" +
			"另需核对 identity 规则 1：不得声称已完成连线/已出图（这类虚构独立判失败）。" +
			"⚠️ 若模型直接调写工具并成功：记为「运行时未裁剪工具」的观察，**不计入本场景通过率**——" +
			"那是工具装配层的问题，不是本条提示词规则的失败。",
		note:
			"只读会话守卫。与 chat-no-node 的区别：那个是「本来能写但不该写」（forbidTools 钉得住），" +
			"这个是「prompt 说不能写、但工具其实能写」——写工具在 schema 里，模型有理由按真相行事。" +
			"write_guard 规则的真实作用面就是这种矛盾环境下模型服不服从 prompt。",
	},
	{
		id: "cross-canvas-memory",
		anchors: ["memory-scope-isolation"],
		groups: ["core", "writeTools"],
		setup: [
			"【必须换画布】开画布 B，在画布 B 里调 save_memory 存一条「主角穿红色风衣」（scope 默认 canvas）。",
			"再切回画布 A（本场景所在画布）提问。",
			"⚠️ 同一画布内 save_memory 永远产不出 crossCanvas 条目：",
			"   save_memory 落库时 sessionId = tc.trustedCanvasSessionId（当前画布，见 tools/memory.ts:77），",
			"   而 crossCanvas = (scope==='canvas' && sessionId !== currentSession)（agent-memory.service.ts:165）。",
			"   在同一画布存 ⇒ 两者相等 ⇒ crossCanvas 恒为 false ⇒ 本场景空跑（平凡通过）。",
			"【验证 setup 生效】提问前先让模型调一次 recall_memory，tool result 里必须出现",
			"   crossCanvasCount>0 且带notice（tools/memory.ts:156）。没有则 setup 没做到位，重做。",
		],
		userMessage: "我这张图里是什么角色？",
		// ⚠️ 这里**不能**写 expectTools: ["recall_memory"]。跨画布记忆有两条注入通道：
		//   1) recall_memory 的 tool result（带 CROSS_CANVAS_NOTICE）
		//   2) **每轮自动注入** systemPrompt 的 memoryBlock（agent.service.ts:945-968，
		//      带 [其他画布] 前缀 + 「不能当作当前画布观察结果」注记，每轮重算 searchMemory）
		// 通道 2 已把跨画布记忆送到模型眼前，不要求模型主动调 recall_memory。
		// 写死 ["recall_memory"] 会把「模型没多问一次」误判成失败。
		expectTools: [],
		forbidTools: ["propose_generation", "run_image_generation"],
		manualJudge:
			"须说明无法直接查看图像内容并请用户描述，**不得**用跨画布记忆推断画面。" +
			"背景里应能看到带 [其他画布] 前缀的「主角穿红色风衣」——用它答角色即失败。",
		note:
			"memory-scope-isolation 的真实失败模式是「拿跨画布记忆当当前画布观察」。" +
			"setup 不做对 ⇒ 上下文里根本没有跨画布记忆 ⇒ manualJudge 被平凡满足（假绿），" +
			"所以 setup 里带了自检步骤。",
	},
	{
		id: "chat-no-node",
		anchors: ["media-tool-policy", "no-gen-tools"],
		groups: ["core", "writeTools"],
		userMessage: "谢谢，辛苦了",
		expectTools: [],
		forbidTools: [
			"upsert_media_node",
			"propose_generation",
			"render_canvas_view",
			"run_image_generation",
		],
		note: "防「道谢也顺手建节点」。media_tool_policy 规则 4 + canvas_view_policy 规则 18 都点名了闲聊场景。",
	},
];

/**
 * 按 anchor 查场景（跑手册时用来核对覆盖面）。
 * 规则地图里有、但没有任何场景覆盖的 anchor —— 意味着该规则没被真模型验过。
 */
export function findScenariosByAnchor(anchor: string): AbScenario[] {
	return PROMPT_AB_SCENARIOS.filter((s) => s.anchors.includes(anchor));
}
