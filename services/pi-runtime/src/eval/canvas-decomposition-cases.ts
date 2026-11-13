/**
 * C-1a · canvas 拆解质量种子集（Q1 拆解时机 + Q2 清单结构）。
 *
 * ## 来源纪律（C-1 立项 spec §3 + 实施规格 §2/§3）
 *
 * 双源：`origin: "production"` = 生产 executionEvents 反查的真实话术（about 必含 13 位
 * 时间戳出处，可溯源）；`origin: "synthetic"` = 结构覆盖必需的自造场景（about 必含
 * 「synthetic」+ 反查不到的理由）。生产出处话术均做了**自包含化改写**——生产原文是
 * 续接多轮上下文的残段，eval 需要独立可跑的完整话术；改写保留任务结构，出处留档。
 *
 * ## 复合判据与双计口径
 *
 * 复合条目同时携带 Q1 召回判据（expectTools/forbidTools）与 Q2 结构判据
 * （expectTodoSnapshot）——一次运行同时产出两象限数据。象限统计按**判据归属**
 * 计数（Q1=8 条、Q2=6 条，均落 C-1a「各 5–7」区间），条目总数 9。
 *
 * ## Q1 负例与三豁免边界（C-1 spec §8.2）
 *
 * 负例话术在编写期规避三条豁免：① 话术自带无歧义参数（防「先查再确认」合理行为）；
 * ② 非澄清请求（ask_user 是决策原语，不算拆解缺失）；③ 非「1 项清单 + 方案说明」形态。
 * 原子性标注写进各条 about。
 */

import type { GoldenCase } from "./golden-cases.js";

export const CANVAS_DECOMPOSITION_CASES: readonly GoldenCase[] = [
	// ── 复合判据：Q1 召回（该拆没拆）+ Q2 结构（拆出来长什么样）──
	{
		id: "c1a-decomp-01",
		origin: "production",
		about:
			"生产出处 1794157769794（短剧分析+创作，生产实际 2 项清单）。多子目标话术必须触发拆解（Q1），且清单覆盖各子目标、互斥不重复（Q2）",
		text: "帮我分析最近一周最火的 10 部短剧，拆解流量背后的底层逻辑，然后帮我选一个类似题材创作一部短剧",
		expectTools: ["todo_write"],
		expectTodoSnapshot: { minItems: 2, maxItems: 4, requireDistinctContent: true },
	},
	{
		id: "c1a-decomp-02",
		origin: "production",
		about:
			"生产出处 1794390082165——**真实「该 propose 没 propose」失败复现**：生产该回合对显式方案请求零拆解工具、直接动生成类工具。本 case 锁定该失败不再发生（Q1 召回核心证据）",
		text: "我需要做一个关于如何使用 codex 制作知识视频的方案，请你帮我设计方案",
		expectTools: ["propose_plan"],
		expectTodoSnapshot: { minItems: 2, maxItems: 6, requireDistinctContent: true },
	},
	{
		id: "c1a-decomp-03",
		origin: "production",
		about:
			"生产出处 1794386994351（时政热点分析，生产 propose_plan 3 步 → todo_write 3 项）。方案→清单双触发（Q1），首步必须是检索/收集类（Q2，生产实测首步为搜索）",
		text: "基于最近一周的时政热点和科技热点，分析各平台流量逻辑，并给出接下来的题材选型建议",
		expectTools: ["todo_write", "propose_plan"],
		expectTodoSnapshot: { minItems: 2, maxItems: 5, firstStepPredicate: "collect" },
	},
	{
		id: "c1a-decomp-04",
		origin: "production",
		about:
			"生产出处 1794373817416（教学视频 tts 方案，生产 3 步管线）。话术自带顺序约束（大纲→TTS→视频），判方案步骤互斥、无巨石项（Q2）",
		text: "我要做一个教学视频：先出教学内容大纲，再根据大纲用 TTS 生成配音，最后用配音驱动画面视频生成。请先给我完整方案",
		expectTools: ["propose_plan"],
		expectTodoSnapshot: { minItems: 2, maxItems: 5, requireDistinctContent: true },
	},
	{
		id: "c1a-decomp-05",
		origin: "production",
		about:
			"生产出处 1794373650015（显式「先出方案」，生产 propose_plan 4 步）。显式方案请求是最强 propose 信号（Q1）；生产 4 步上限锚定 maxItems（Q2）",
		text: "请你先把制作这个教学视频的完整方案给出来，我确认后再开始实施",
		expectTools: ["propose_plan"],
		expectTodoSnapshot: { minItems: 2, maxItems: 6 },
	},
	// ── 纯 Q2 结构：显式枚举形态（synthetic，反查不到自包含载体）──
	{
		id: "c1a-decomp-06",
		origin: "synthetic",
		about:
			"synthetic 理由：显式编号枚举多指令的完整话术在生产反查中均为续接上下文的残段，无法自包含复现——此形态是「items 数下限 + 互斥」判据的最干净载体。requiresCanvasNodes=3（需要真实文本节点）",
		text: "帮我依次完成三件事：① 把画布上所有文本节点的文案改成红色主题措辞 ② 为这个主题生成一张封面图 ③ 完成后把新旧节点排成一行",
		expectTools: ["todo_write"],
		expectTodoSnapshot: { minItems: 3, maxItems: 6, requireDistinctContent: true },
		requiresCanvasNodes: 3,
	},
	// ── Q1 负例：单步/纯查询任务不得过度拆解（§8.2 原子性编写期标注）──
	{
		id: "c1a-decomp-n1",
		origin: "production",
		about:
			"生产出处 1794037033829（生产实证未拆解、直接生成——正确行为）。原子性 ≤1 个调用（一次图片生成提交）；单步任务不得触发拆解工具（过度拆解也是质量缺陷）。不设 expectTools：生成类工具是否在本回合内提交取决于确认流分支（不写死）",
		text: "再帮我生成一条牧羊犬的图片",
		forbidTools: ["todo_write", "propose_plan"],
	},
	{
		id: "c1a-decomp-n2",
		origin: "production",
		about:
			"生产出处 1794072144236（纯提问）。原子性 0 个调用（只读探针是否调用取决于实现路径——判据只锁「不写画布、不拆解」）；纯查询请求不得触发拆解也不得写画布",
		text: "画布上这些节点有相互重叠的吗？",
		forbidTools: [
			"todo_write",
			"propose_plan",
			"create_nodes_batch",
			"upsert_media_node",
			"set_node_text",
			"arrange_nodes",
		],
	},
	{
		id: "c1a-decomp-n3",
		origin: "production",
		about:
			"生产出处 1794319138173。原子性 ≤1 个调用（一次布局整理完成视角收敛）；布局整理类单原子操作不得触发拆解。先查再确认与直接整理两者都是正确行为，判据只锁不得拆解。requiresCanvasNodes=3",
		text: "画布上的节点没法在一个视角内看到，帮我把它们整理到一屏内",
		forbidTools: ["todo_write", "propose_plan"],
		requiresCanvasNodes: 3,
	},
];
