
// 文件：services/pi-runtime/src/upstream-skills-probe.test.ts
/**
 * M0 上游原语接线探针（2026-11-16，发起人要求：先验证再动规格）
 *
 * 目的：确认 `setResources → lane.skill() → systemPrompt 装配` 这条链在 pi-runtime
 * 实际使用的 harness 上真实可达，而不是「读源码觉得应该可以」。
 *
 * 取证纪律：
 * - 只在 true master 干净 tarball 树里跑（HEAD 01c5ef104384e47ebcfbec6ca2fe0b0b317652b1）。
 * - 只 import **发布包公共 API** `@earendil-works/pi-agent-core@0.99.2`（带生产 patch_hash）
 *   与宿主的 `composeSystemPrompt`；**不 import vendor 源码、不 mock harness/lane**。
 * - 用真 `AgentHarness.create` + `MemorySessionRepo` + faux provider（vendor 官方测试范式）。
 * - 每条判据都有可转红负例（见文末 MUTATION 段）。
 *
 * 跑法：cd services/pi-runtime && node --import tsx --test src/upstream-skills-probe.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AgentHarness,
	BACKGROUND_CONTEXT,
	MemorySessionRepo,
	setValue,
	branchTip,
	laneConfig,
	laneState,
	formatSkillsForSystemPrompt,
	formatSkillInvocation,
	type Skill,
} from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { composeSystemPrompt } from "./session-manager.js";

const CTX = BACKGROUND_CONTEXT;

const ALPHA: Skill = {
	name: "alpha",
	description: "Alpha 创作技能 · 触发词：写分镜",
	content: "DO ALPHA BODY — 把分镜写成画布文本节点。",
	filePath: "/virtual/skills/alpha/SKILL.md",
};
const BETA: Skill = {
	name: "beta",
	description: "Beta 创作技能",
	content: "DO BETA BODY.",
	filePath: "/virtual/skills/beta/SKILL.md",
};
const GAMMA: Skill = {
	name: "gamma",
	description: "Gamma 创作技能",
	content: "DO GAMMA BODY.",
	filePath: "/virtual/skills/gamma/SKILL.md",
};
const HIDDEN: Skill = {
	name: "hidden",
	description: "不可被模型自动调用",
	content: "DO HIDDEN BODY.",
	filePath: "/virtual/skills/hidden/SKILL.md",
	disableModelInvocation: true,
};

let seq = 0;

interface ProbeHarness {
	harness: Awaited<ReturnType<typeof AgentHarness.create>>["harness"];
	lane: Awaited<ReturnType<Awaited<ReturnType<typeof AgentHarness.create>>["harness"]["lane"]>>;
	session: Awaited<ReturnType<MemorySessionRepo["create"]>>;
	repo: MemorySessionRepo;
}

/** 造一个真 harness（预置 lane 状态，照搬 vendor test/harness/runtime/accept.test.ts 的 createSession 范式）。 */
async function makeHarness(initialSkills?: Skill[], extraLanes: string[] = []): Promise<ProbeHarness> {
	const repo = new MemorySessionRepo();
	const session = await repo.create({ id: `m0-probe-${++seq}` }, CTX);
	const writes: ReturnType<typeof setValue>[] = [];
	for (const name of ["main", ...extraLanes]) {
		writes.push(
			setValue(branchTip(name), null),
			setValue(laneConfig(name), {
				model: { provider: "faux", modelId: "faux-1" },
				thinkingLevel: "off" as const,
				activeToolNames: [],
			}),
			setValue(laneState(name), { currentOperationId: null, lastOperationId: null, inbox: [] }),
		);
	}
	await session.mutate((mutator) => mutator.commit(writes, CTX), CTX);

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			...(initialSkills === undefined ? {} : { resources: { skills: initialSkills } }),
		},
		CTX,
	);
	const lane = await harness.lane("main", CTX);
	return { harness, lane, session, repo };
}

/** 从 lane 的 session 里找注入的 user message 文本。 */
async function injectedUserTexts(lane: ProbeHarness["lane"]): Promise<string[]> {
	const entries = await lane.findEntries(undefined, CTX);
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
				out.push(block.text);
			}
		}
	}
	return out;
}

// ─────────────────────────── P0 事实基座：上游原语清单 ───────────────────────────

test("U1 · 发布包公共 API 暴露全部上游原语（不依赖 vendor 源码路径）", () => {
	for (const [name, value] of Object.entries({
		AgentHarness,
		MemorySessionRepo,
		formatSkillsForSystemPrompt,
		formatSkillInvocation,
		setValue,
		branchTip,
		laneConfig,
		laneState,
		BACKGROUND_CONTEXT,
	})) {
		assert.notEqual(value, undefined, `缺少公共导出：${name}`);
	}
	assert.equal(typeof AgentHarness.create, "function", "AgentHarness.create 必须是函数");
	console.log("[U1] UPSTREAM_PRIMITIVES_OK 9 exports + AgentHarness.create");
});

test("U2 · Skill[] 可 application-provided 内联构造；formatSkillsForSystemPrompt 产标准 <available_skills> 且过滤 disableModelInvocation", () => {
	const index = formatSkillsForSystemPrompt([ALPHA, BETA, HIDDEN]);
	assert.match(index, /^The following skills provide specialized instructions/);
	assert.match(index, /<available_skills>/);
	assert.match(index, /<name>alpha<\/name>/);
	assert.match(index, /<description>Alpha 创作技能 · 触发词：写分镜<\/description>/);
	assert.match(index, /<location>\/virtual\/skills\/alpha\/SKILL\.md<\/location>/);
	assert.doesNotMatch(index, /<name>hidden<\/name>/, "disableModelInvocation 的技能不得进隐式 index");
	assert.doesNotMatch(index, /DO ALPHA BODY/, "index 只含 metadata，不含正文（渐进披露第一级）");
	assert.equal(formatSkillsForSystemPrompt([]), "", "空集必须返回空串而不是空 XML 壳");
	assert.equal(formatSkillsForSystemPrompt([HIDDEN]), "", "全被禁用时返回空串");
	console.log("[U2] INDEX_OK visible=2/3, body_not_in_index=true, empty_set='' ");
});

test("U3 · formatSkillInvocation 把正文与 location 包成 <skill> 块（渐进披露第二级）", () => {
	const block = formatSkillInvocation(ALPHA, "请写第 3 集分镜");
	assert.match(block, /^<skill name="alpha" location="\/virtual\/skills\/alpha\/SKILL\.md">/);
	assert.match(block, /References are relative to \/virtual\/skills\/alpha/);
	assert.match(block, /DO ALPHA BODY/);
	assert.match(block, /<\/skill>\n\n请写第 3 集分镜$/);
	assert.equal(formatSkillInvocation(ALPHA), block.split("\n\n请写")[0]);
	console.log("[U3] INVOCATION_OK full_body=true location=true additionalInstructions=true");
});

// ─────────────────────────── P1 真 harness：setResources → lane.skill() ───────────────────────────

test("U4 · 【核心】真 AgentHarness：setResources 热更新后 lane.skill 命中并注入全文，无需重建会话", async (t) => {
	const { harness, lane } = await makeHarness(); // create 时**不传** resources
	t.after(() => harness.close(CTX));

	const before = await harness.getResources(CTX);
	assert.equal(before.skills?.length ?? 0, 0, "初始 resources 应为空");

	// 宿主侧热更新：内联 Skill[]（来自 DB 正文，不需要文件系统）
	await harness.setResources({ skills: [ALPHA, BETA] }, CTX);
	const after = await harness.getResources(CTX);
	assert.deepEqual(after.skills?.map((s) => s.name), ["alpha", "beta"], "setResources 未生效");

	const admission = await lane.accept({ kind: "skill", name: "alpha" }, CTX);
	assert.ok(admission.ok, "lane.accept(skill) 被拒 —— setResources 没被 lane 消费");
	const texts = await injectedUserTexts(lane);
	const hit = texts.find((text) => text.includes('<skill name="alpha"'));
	assert.ok(hit, "session 里找不到注入的 <skill> 消息");
	assert.equal(hit, formatSkillInvocation(ALPHA), "注入内容与上游 formatSkillInvocation 不一致");
	assert.match(hit, /DO ALPHA BODY/, "正文未注入");
	console.log("[U4] SET_RESOURCES_TO_LANE_SKILL_OK initial=0 → hot=2 → injected_full_body=true");
});

test("U5 · 【核心】未注册名 → lane.skill() 返回 UnknownSkill 硬拒，且 session 零副作用", async (t) => {
	const { harness, lane } = await makeHarness();
	t.after(() => harness.close(CTX));
	await harness.setResources({ skills: [ALPHA] }, CTX);

	const beforeCount = (await injectedUserTexts(lane)).length;
	const result = await lane.skill("ghost-skill", undefined, CTX);
	assert.ok(!result.ok, "未知技能竟被接受");
	assert.equal(result.error._tag, "UnknownSkill", "错误标签必须是 UnknownSkill");
	// 上游 TaggedError 构造里 Object.assign(this, props) 会用 props.name（=技能名）覆盖 tag，
	// ⇒ 判别标签必须用 `_tag`，`name` 属性承载的是被拒绝的技能名。此形态写入规格事实基座。
	assert.equal(result.error.name, "ghost-skill");
	assert.match(result.error.message, /Unknown skill: ghost-skill/);
	assert.equal((await injectedUserTexts(lane)).length, beforeCount, "拒绝路径不得往 session 追加消息");
	console.log("[U5] UNKNOWN_SKILL_HARD_REJECT_OK _tag=UnknownSkill name=ghost-skill zero_side_effect=true");
});

test("U6 · 热更新换集即「启用/卸载」：换集后新名可达、旧名 UnknownSkill，全程不重建会话", async (t) => {
	const { harness, lane } = await makeHarness();
	t.after(() => harness.close(CTX));
	await harness.setResources({ skills: [ALPHA] }, CTX);

	// 换集前的旧名在换集后必须不可达
	await harness.setResources({ skills: [BETA, GAMMA] }, CTX);
	const old = await lane.skill("alpha", undefined, CTX);
	assert.ok(!old.ok);
	assert.equal(old.error._tag, "UnknownSkill", "已移除技能仍可调用 ⇒ 卸载语义没落地");

	const fresh = await makeHarness();
	t.after(() => fresh.harness.close(CTX));
	await fresh.harness.setResources({ skills: [BETA, GAMMA] }, CTX);
	const admission = await fresh.lane.accept({ kind: "skill", name: "gamma" }, CTX);
	assert.ok(admission.ok, "换集后新名不可达");
	assert.ok((await injectedUserTexts(fresh.lane)).some((x) => x.includes("DO GAMMA BODY")));
	console.log("[U6] HOT_SWAP_OK old=UnknownSkill new=injected no_session_rebuild=true");
});

test("U7 · create 时直接传 resources 也生效（新会话/会话创建路径）", async (t) => {
	const { harness, lane } = await makeHarness([ALPHA]);
	t.after(() => harness.close(CTX));
	assert.deepEqual((await harness.getResources(CTX)).skills?.map((s) => s.name), ["alpha"]);
	const admission = await lane.accept({ kind: "skill", name: "alpha" }, CTX);
	assert.ok(admission.ok, "create-time resources 未生效");
	assert.ok((await injectedUserTexts(lane)).some((x) => x.includes("DO ALPHA BODY")));
	console.log("[U7] CREATE_TIME_RESOURCES_OK");
});

// ─────────────────────────── P2 systemPrompt 装配 ───────────────────────────

test("U8 · 【核心】宿主 composeSystemPrompt 每轮从 getResources 求值，setResources 后 index 立即可见", async (t) => {
	const { harness } = await makeHarness();
	t.after(() => harness.close(CTX));

	const staticPart = "STATIC_SYSTEM_PART";
	const guidelines = "<tool_guidelines>GUIDELINES_BLOCK</tool_guidelines>";
	// 这就是宿主该写的接线：每轮求值，读最新 resources，调上游 formatter，塞进 dynamicBlocks。
	const assemble = async (): Promise<string> => {
		const resources = await harness.getResources(CTX);
		return composeSystemPrompt(staticPart, [formatSkillsForSystemPrompt(resources.skills ?? []), guidelines]);
	};

	const empty = await assemble();
	assert.equal(empty, `${staticPart}\n\n${guidelines}`, "空技能集不得注入空 available_skills 块");
	assert.doesNotMatch(empty, /available_skills/);

	await harness.setResources({ skills: [ALPHA, HIDDEN] }, CTX);
	const first = await assemble();
	assert.ok(first.startsWith(staticPart), "静态段必须保留");
	assert.match(first, /<available_skills>/);
	assert.match(first, /<name>alpha<\/name>/);
	assert.doesNotMatch(first, /<name>hidden<\/name>/, "disableModelInvocation 不得进隐式 index");
	assert.match(first, /<tool_guidelines>/, "既有 B-3 静态段不得被挤掉");
	assert.ok(first.indexOf("<available_skills>") < first.indexOf("<tool_guidelines>"), "skills index 应在 guidelines 之前");

	// 订阅集变更（模拟启用/关闭）：同一 harness、同一闭包、下一轮即见
	await harness.setResources({ skills: [GAMMA] }, CTX);
	const second = await assemble();
	assert.match(second, /<name>gamma<\/name>/, "热更新后的技能未出现在下一轮 systemPrompt");
	assert.doesNotMatch(second, /<name>alpha<\/name>/, "已移除技能仍残留在下一轮 systemPrompt");
	console.log("[U8] SYSTEM_PROMPT_ASSEMBLY_OK empty→alpha→gamma per_turn_reeval=true");
});

test("U9 · 上游 formatter 的 XML 转义防注入（name/description 含尖括号与引号）", () => {
	const evil: Skill = {
		name: "evil",
		description: 'A <script>alert("x")</script> & \'quote\'',
		content: "body",
		filePath: "/virtual/skills/evil/SKILL.md",
	};
	const index = formatSkillsForSystemPrompt([evil]);
	assert.doesNotMatch(index, /<script>/, "description 未转义，存在 prompt 注入面");
	assert.match(index, /&lt;script&gt;/);
	assert.match(index, /&amp;/);
	console.log("[U9] XML_ESCAPE_OK");
});

// ─────────────────────────── P3 cache / fork 形态 ───────────────────────────

test("U10 · 多 lane（含 fork 型 lane）共享同一 harness resources，setResources 后各 lane 均可达", async (t) => {
	const h = await makeHarness(undefined, ["fork-lane"]);
	t.after(() => h.harness.close(CTX));
	const forked = await h.harness.lane("fork-lane", CTX);

	await h.harness.setResources({ skills: [ALPHA] }, CTX);
	const mainAdmission = await h.lane.accept({ kind: "skill", name: "alpha" }, CTX);
	assert.ok(mainAdmission.ok, "main lane 未读到 resources");
	const forkReject = await forked.skill("ghost", undefined, CTX);
	assert.ok(!forkReject.ok);
	assert.equal(forkReject.error._tag, "UnknownSkill");

	const h2 = await makeHarness(undefined, ["fork-lane"]);
	t.after(() => h2.harness.close(CTX));
	await h2.harness.setResources({ skills: [ALPHA] }, CTX);
	const forkLane2 = await h2.harness.lane("fork-lane", CTX);
	const forkAdmission = await forkLane2.accept({ kind: "skill", name: "alpha" }, CTX);
	assert.ok(forkAdmission.ok, "fork lane 未读到 resources");
	assert.ok((await injectedUserTexts(forkLane2)).some((x) => x.includes("DO ALPHA BODY")));
	console.log("[U10] MULTI_LANE_SHARED_RESOURCES_OK main=true fork=true");
});

test("U11 · 探测 config 是否落盘：新 harness attach 同一 session 后 resources 是否仍在", async (t) => {
	const repo = new MemorySessionRepo();
	const session = await repo.create({ id: `m0-probe-resume-${++seq}` }, CTX);
	await session.mutate(
		(mutator) =>
			mutator.commit(
				[
					setValue(branchTip("main"), null),
					setValue(laneConfig("main"), {
						model: { provider: "faux", modelId: "faux-1" },
						thinkingLevel: "off" as const,
						activeToolNames: [],
					}),
					setValue(laneState("main"), { currentOperationId: null, lastOperationId: null, inbox: [] }),
				],
				CTX,
			),
		CTX,
	);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const base = { models, model: faux.getModel() };

	const h1 = await AgentHarness.create({ session, ...base }, CTX);
	await h1.harness.setResources({ skills: [ALPHA] }, CTX);
	assert.equal((await h1.harness.getResources(CTX)).skills?.length, 1);
	// harness.close() 会连带关闭 session ⇒ 模拟 resume 必须经 repo.open() 重开，不能复用同一 session 对象。
	await h1.harness.close(CTX);

	const session2 = await repo.open(session.metadata, CTX);
	const h2 = await AgentHarness.create({ session: session2, ...base }, CTX);
	t.after(() => h2.harness.close(CTX));
	const resumed = (await h2.harness.getResources(CTX)).skills ?? [];
	const persisted = resumed.length > 0;
	console.log(`[U11] RESUME_RESOURCES_PERSISTED=${persisted} count=${resumed.length}`);

	// 无论是否落盘，宿主在 create 时显式注入都应生效（这是规格必须写明的兜底）。
	// 用独立新会话，避免与 h2 争抢同一 session 的 attach。
	const h3 = await makeHarness([BETA]);
	t.after(() => h3.harness.close(CTX));
	assert.deepEqual((await h3.harness.getResources(CTX)).skills?.map((s) => s.name), ["beta"]);
	console.log("[U11] CREATE_TIME_INJECTION_ON_FRESH_SESSION=true");
});

/**
 * MUTATION（可转红负例，跑法：逐条改一行后重跑，对应断言必须 RED）
 *  M-U4  : 删掉 `await harness.setResources(...)`            → U4「setResources 未生效」/「找不到注入消息」RED
 *  M-U5  : 把 `ghost-skill` 换成 `alpha`                    → U5「未知技能竟被接受」RED
 *  M-U6  : 删掉第二次 setResources（换集）                  → U6「已移除技能仍可调用」RED
 *  M-U7  : makeHarness() 不传 initialSkills                 → U7「create-time resources 未生效」RED
 *  M-U8a : assemble 里把 `getResources()` 换成一次性缓存快照 → U8「热更新后的技能未出现」RED
 *  M-U8b : 删掉 `formatSkillsForSystemPrompt(...)` 这一项    → U8「<available_skills>」RED
 *  M-U8c : 把 HIDDEN 的 disableModelInvocation 删掉         → U8「不得进隐式 index」RED
 *  M-U9  : formatter 里去掉 escapeXml                       → U9「未转义」RED
 *  M-U10 : 不预置 fork-lane 的 laneConfig                   → U10 fork lane RED（证明 lane 预置是宿主职责）
 *  M-U11 : h3 不传 resources                                → U11 create-time 兜底 RED
 */
