/**
 * C-1b · Q3 多轮拆解跟踪 + Q4 派发观测场景集。
 *
 * ## 结构（实施 spec：docs/superpowers/specs/2026-11-13-c1b-fullset-multiturn-eval-design.md）
 *
 * - Q3（q3-01…08）：三步结构（拆解 → 中途 → 收尾），判 updates 增量序列
 *   （requireProgress）+ 终态 status 分布（allOf/requireAnyOf）+ §8.6 identity
 *   断裂观测（只观测不计分）。**steps case 强制 repeat=1**（3 步 × 2–4 次 LLM
 *   调用/步；抖动兜底由「全集跑通 ≥2 轮跨 run 对比」承担——显式例外登记于 spec §3.1）。
 * - Q4（q4-01…05）：派发观测，**观测期不设强门禁**（expectAnyTools 宽松二选一，
 *   扩强门禁等 spawned 持续性数据——#858 后 7 天复核纪律）。
 *
 * ## 话术来源纪律（同 C-1a：production 必含 13 位出处）
 *
 * 多轮素材来自生产真实多轮会话（thread cmw8its1u00yunn010ong5b3f，13 次拆解
 * 工具调用，2026-11-13 只读副本反查）：拆解 → 纠偏 → 追加 → 继续推进全链实证。
 * ⭐ 关键生产实证：同任务跨轮 **content 逐字稳定**（「细化EP01-05剧本（按秒拆解节奏表）」
 * 跨 5 个快照逐字不变、status pending→completed）⇒ requireProgress 与 identity
 * 观测的数据面成立；同时抓到 content 被追加括号细节的形态（「核心场景概念图生成」
 * →「核心场景概念图生成（老街区+物流仓库）」）⇒ identity 保守口径（逐字比对）
 * 会把它计为断裂——符合 §8.6「宁可高估」裁决，报告中须写明口径。
 *
 * ⚠️ 续接步骤话术的诚实标注：生产续接话术（「继续」「按建议推进」）是**残段**，
 * eval 需要自包含会话——step1 用生产原话术，续接步为通用短语（生产同形态词表：
 * 「继续」「继续推进」「按建议继续推进」，出处同 thread 实测）。各 case about 登记。
 */

import type { GoldenCase } from "./golden-cases.js";

/**
 * 生产实证的三步快照演进（thread cmw8its1u00yunn010ong5b3f，requireProgress 设计锚）：
 *
 * ts=1794186702399: [in_progress] 细化EP01-05剧本…  [pending] 反派周建国…  [pending] 核心场景…
 * ts=1794186836180: [completed ] 细化EP01-05剧本…  [in_progress] 反派…   [pending] 核心场景…
 * ts=1794187615943: [completed ] …  [completed] …  [in_progress] 核心场景概念图生成（老街区+物流仓库）
 *                     ↑ content 追加括号细节 = identity 保守口径的高估源（登记于报告）
 */
export const CANVAS_MULTITURN_CASES: readonly GoldenCase[] = [
	// ═══════════ Q3 · 多轮拆解跟踪（8 条，steps 结构，repeat=1）═══════════
	{
		id: "c1b-q3-01",
		origin: "production",
		about:
			"生产出处 1794184233536 + 续接 1794185876215/1794187305252（thread cmw8its1u00yunn010ong5b3f 真实多轮形态：拆解→继续推进→收尾）。" +
			"锁：全周期 status 前进跟踪（requireProgress 的生产实证场景）+ 收尾存在 completed。续接步为通用短语（生产同形态词表实测）",
		steps: [
			{
				text: "请帮我分析最近一周内最火的10部短剧，分析这些短剧火背后流量加持的底层逻辑，不轻易采信，需要论证清楚",
				expectTools: ["todo_write"],
				expectTodoSnapshot: { minItems: 2, maxItems: 6, firstStepPredicate: "collect" },
			},
			{
				text: "好，继续推进",
				expectTodoSnapshot: { minItems: 2 },
				expectTodoStatus: { requireProgress: true },
				expectIdentitySurvival: { itemIndex: 0 },
			},
			{
				text: "把剩余任务完成，输出最终分析报告",
				expectTodoStatus: { requireAnyOf: ["completed"] },
			},
		],
	},
	{
		id: "c1b-q3-02",
		origin: "production",
		about:
			"生产出处 1794184233536 + 1794185334629（真实多轮形态：分析中途追加「出一部短剧」子目标，生产实证清单被扩充）。" +
			"锁：中途追加项后新快照覆盖新旧目标（minItems≥2），续接推进有进度。续接步为通用短语（生产同形态实测）",
		steps: [
			{
				text: "请帮我分析最近一周内最火的10部短剧，分析这些短剧火背后流量加持的底层逻辑",
				expectTools: ["todo_write"],
				expectTodoSnapshot: { minItems: 2, maxItems: 6 },
			},
			{
				text: "请基于以上分析结论，帮我出一部短剧，充分借鉴前面的流量逻辑",
				expectTodoSnapshot: { minItems: 2, maxItems: 6 },
			},
			{
				text: "按你的思路继续推进",
				expectTodoStatus: { requireProgress: true },
			},
		],
	},
	{
		id: "c1b-q3-03",
		origin: "production",
		about:
			"生产出处 1794184233536 + 措辞改写诱导（§8.6 identity 断裂观测**主场景**）。" +
			"step2 显式要求改写清单措辞 ⇒ 保守口径下预期断裂（broken++）——本 case 的价值是把「断裂率上界」实测出来供 A-2' 立项引用。" +
			"**identity 只观测不计分**：step2 判据只锁「有快照、结构合规」，不断言 content 逐字存活",
		steps: [
			{
				text: "请帮我分析最近一周内最火的10部短剧，并给出流量逻辑分析框架",
				expectTools: ["todo_write"],
				expectTodoSnapshot: { minItems: 2, maxItems: 6 },
				expectIdentitySurvival: { itemIndex: 0 },
			},
			{
				text: "把刚才的清单重新梳理一遍，每项的描述写得更具体一些",
				expectTodoSnapshot: { minItems: 2, maxItems: 6 },
			},
			{
				text: "按新清单继续推进",
				expectTodoStatus: { requireProgress: true },
			},
		],
	},
	{
		id: "c1b-q3-04",
		origin: "production",
		about:
			"生产出处 1794184233536 + 1794184732742（真实纠偏形态：「为什么是2025年8月？不是应该联网搜索最新一周时间」——自包含化改写）。" +
			"锁：中途澄清（豁免②：澄清请求不算拆解缺失）不写画布、不打断清单推进；澄清后回到清单继续。step2 判据刻意宽松（澄清步是否重发清单取决于实现路径，不写死）",
		steps: [
			{
				text: "请帮我分析最近一周内最火的10部短剧，分析流量逻辑",
				expectTools: ["todo_write"],
				expectTodoSnapshot: { minItems: 2, maxItems: 6 },
			},
			{
				text: "等等，「最近一周」具体是指哪几天？请先联网确认最新日期范围再继续分析",
				forbidTools: ["upsert_media_node", "propose_generation", "create_nodes_batch"],
			},
			{
				text: "好，按确认后的时间范围继续推进",
				expectTodoStatus: { requireProgress: true },
			},
		],
	},
	{
		id: "c1b-q3-05",
		origin: "production",
		about:
			"生产出处 1794373650015（显式方案请求）+ 1794373872834（「继续」推进，thread cmwbnm20j004nla012dgslazs 实证方案→清单接管链）。" +
			"锁：propose_plan → todo_write 双工具协同（方案确认后清单接管），步骤 2 清单规模与方案一致量级（minItems≥2）",
		steps: [
			{
				text: "请你先把制作这个教学视频的完整方案给出来，我确认后再开始实施",
				expectTools: ["propose_plan"],
				expectTodoSnapshot: { minItems: 2, maxItems: 6 },
			},
			{
				text: "方案可以，开始执行第一步",
				expectTools: ["todo_write"],
				expectTodoSnapshot: { minItems: 2 },
			},
			{
				text: "继续执行剩余步骤",
				expectTodoStatus: { requireProgress: true, requireAnyOf: ["in_progress", "completed"] },
			},
		],
	},
	{
		id: "c1b-q3-06",
		origin: "production",
		about:
			"生产出处 1794187780421（收尾形态实证：三项 completed + 一项 in_progress，thread cmw8its1u00yunn010ong5b3f）。" +
			"锁：收尾步不得残留 pending 幽灵项（allOf 白名单）且存在 completed（requireAnyOf）。三步推进路径同生产（拆解→推进→收尾），续接步为通用短语",
		steps: [
			{
				text: "帮我完成短剧创作的三件事：写EP01-05剧本大纲、设计反派角色视觉锚点、生成核心场景概念图",
				expectTools: ["todo_write"],
				expectTodoSnapshot: { minItems: 3, maxItems: 6, requireDistinctContent: true },
			},
			{
				text: "继续推进",
				expectTodoStatus: { requireProgress: true },
			},
			{
				text: "把剩余任务全部收尾完成",
				expectTodoStatus: { allOf: ["in_progress", "completed"], requireAnyOf: ["completed"] },
			},
		],
	},
	{
		id: "c1b-q3-07",
		origin: "synthetic",
		about:
			"synthetic 理由：「拆解+生成+布局复合任务的三步推进 + 画布终态上界断言」的完整自包含载体在生产反查中无对应（生产复合任务均为续接残段）。" +
			"锁：Q3 与 expectCanvasState 的组合形态（画布污染裁决：nodeCount 只许上界 max=8——多轮生成跨 case 累积不可控，写下界即环境 flaky）。" +
			"requiresCleanCanvas=true 走预检路径（layout-smoke 画布 3 节点 ≤ 8 应通过）",
		requiresCleanCanvas: true,
		steps: [
			{
				text: "帮我依次完成：① 把画布上所有文本节点文案改成庆祝主题 ② 生成一张庆祝主题配图 ③ 完成后把新旧节点排成一行",
				expectTools: ["todo_write"],
				expectTodoSnapshot: { minItems: 3, maxItems: 6, requireDistinctContent: true },
			},
			{
				text: "继续完成剩下的事项",
				expectTodoStatus: { requireProgress: true },
			},
			{
				text: "收尾：把剩余任务做完，节点排整齐",
				expectTodoStatus: { requireAnyOf: ["completed"] },
				expectCanvasState: { nodeCount: { max: 8 } },
			},
		],
	},
	{
		id: "c1b-q3-08",
		origin: "production",
		about:
			"生产出处 1793444238779→1793605581325（thread cmvwads7g003up801s82h0zqh 真实换任务形态：猴子任务中途插入乌龟/老黄牛新任务，生产实证清单被替换）。" +
			"锁：中途换任务不得假称原任务完成（forbidText）；回到原任务时重发清单（快照存在）。" +
			"⚠️ step3 刻意**不**声明 requireProgress：step2（单步生成）生产实证不拆解（c1a-decomp-n1 同形态）⇒ 无上一步快照可比，requireProgress 会恒 fail——这是换任务场景的编写期标注纪律（实施 spec §3.1）",
		steps: [
			{
				text: "帮我分析一下猴子题材的短视频在两大平台的流量差异，给出创作建议",
				expectTools: ["todo_write"],
				expectTodoSnapshot: { minItems: 2, maxItems: 6 },
			},
			{
				text: "先不管这个了，帮我直接生成一只猴子玩偶的商品图",
				forbidText: ["已完成所有任务", "全部任务已完成"],
			},
			{
				text: "回到刚才的流量分析任务，继续推进",
				expectTodoSnapshot: { minItems: 1, maxItems: 6 },
			},
		],
	},

	// ═══════════ Q4 · 派发观测（5 条，观测期宽松门禁）═══════════
	{
		id: "c1b-q4-01",
		origin: "production",
		about:
			"生产出处 1794386792852（**生产实证：大调研回合的工具序列 = 仅 spawn_subagent，直接派发**）。" +
			"观测期判据：大范围多源调研话术应派发子代理（expectAnyTools 单候选=生产实证路径；强门禁 expectTools 等 spawned 持续性数据）",
		text: "帮我深入调研一下最近一周时政、科技两大领域的热点事件和流量逻辑，整理成 top10 短视频选题清单，信息要多源交叉验证",
		expectAnyTools: ["spawn_subagent"],
	},
	{
		id: "c1b-q4-02",
		origin: "production",
		about:
			"生产出处 1794389008908（「用子代理重新跑一遍分析流程」——用户显式指令=最强派发信号，自包含化改写）。" +
			"锁：显式指令下必须 spawn_subagent（这是 #858 点名线的直接行为验收面）",
		text: "请用子代理帮我跑一遍完整分析：调研最近一周短剧赛道的热门题材，并输出选题建议",
		expectAnyTools: ["spawn_subagent"],
	},
	{
		id: "c1b-q4-03",
		origin: "production",
		about:
			"生产出处 1794386792852 + 1794388824637（**真金用户纠偏反馈**：「以上调研分析为什么没有调用子 agent？」——该派没派的失败面被用户点名的生产实证）。" +
			"两步观测：step1 观测大调研是否**自发**派发（宽松：spawn_subagent 或只读工具族二选一）；step2 纠偏后是否改用 spawn_subagent。" +
			"这是「三层点名模型」P3（系统提示点名）生效与否的直接行为观测面（实施 spec §5）；两分支结果都由报告呈现",
		steps: [
			{
				text: "帮我调研最近一周AI领域的热点事件，分析背后的技术趋势",
				// 观测期宽松：派发或前置只读动作二选一（扩强门禁等 #858 后 7 天 spawned 持续性数据）
				expectAnyTools: ["spawn_subagent", "get_canvas_summary", "get_canvas_layout", "get_node"],
			},
			{
				text: "为什么这次调研没有调用子 agent？请用子代理重新跑一遍调研流程",
				expectAnyTools: ["spawn_subagent"],
			},
		],
	},
	{
		id: "c1b-q4-04",
		origin: "production",
		about:
			"生产出处 1793444238779（「生成一只猴子」单步生成——生产实证未派发子代理，正确行为）。" +
			"克制负例：单步生成不得派发子代理（隔离上下文成本 > 单步收益）",
		text: "帮我生成一只猴子玩偶的商品图",
		forbidTools: ["spawn_subagent"],
	},
	{
		id: "c1b-q4-05",
		origin: "production",
		about:
			"生产出处 1793627084440（「查看现在有哪些生成任务正在执行」状态查询——生产实证未派发）。" +
			"克制负例：状态查询/轻量问答不得派发子代理（round trip 成本纯浪费）",
		text: "查看现在有哪些生成任务正在执行？",
		forbidTools: ["spawn_subagent"],
	},
];
