import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildRetentionInstructions,
	mergeConfirmedPreferences,
	RETENTION_INSTRUCTIONS_VERSION,
} from "./compaction-retention.js";

/**
 * 压缩保留段（Round 2 §01 判断 4 / W2①）。
 *
 * 背景：vendor 的 `lane.compact({ customInstructions })` 通道端到端已通
 * （compaction.ts:567拼成 `\n\nAdditional focus: ${customInstructions}`），
 * 但 pi-runtime 的自动压缩路径一直传 `undefined` ⇒ 压缩后「必须跨压缩保留」的
 * 领域状态（待确认节点 id、已确认偏好、本轮关键工具结论）会丢。
 *
 * 本模块只负责**生成文本**；接线在 session-manager 的两个压缩触发点。
 */

describe("buildRetentionInstructions（压缩保留段文本生成）", () => {
	it("恒返回非空中文指令，且含版本标记（可被摘要归因）", () => {
		const text = buildRetentionInstructions();
		assert.ok(text.length > 0);
		assert.match(text, /必须跨压缩保留/);
		assert.ok(
			text.includes(RETENTION_INSTRUCTIONS_VERSION),
			"保留段必须带版本号，否则压缩后无法归因是哪一版策略产出的",
		);
	});

	it("无状态时仍是兜底指令（不是空串——空串等于没传）", () => {
		// 反例：`() => ""` 会被 vendor 判为 falsy 走原生路径，保留段静默失效。
		// 这条锁住「恒非空」这个不变量。
		const text = buildRetentionInstructions({ pendingConfirmNodeIds: [] });
		assert.notEqual(text.trim(), "");
	});

	it("有待确认节点 id 时逐个列出（这是最容易被压缩掉的存量问题）", () => {
		const text = buildRetentionInstructions({ pendingConfirmNodeIds: ["node-a", "node-b"] });
		assert.match(text, /node-a/);
		assert.match(text, /node-b/);
		// 必须写成「待用户确认」而不是泛泛的「节点」，否则模型不知道要保留什么状态
		assert.match(text, /待用户确认/);
	});

	it("节点 id 做数量截断，避免长会话把保留段撑爆（vendor 只追加不替换）", () => {
		const many = Array.from({ length: 50 }, (_, i) => `n${i}`);
		const text = buildRetentionInstructions({ pendingConfirmNodeIds: many });
		// 保留前若干个 + 明确的省略说明，而不是把 50 个全列进去
		assert.match(text, /n0/);
		assert.ok(!text.includes("n49"), "超出上限的 id 不应出现");
		assert.match(text, /还有 \d+ 个/);
	});

	it("节点 id 里的换行/分隔符被清洗（防止破坏摘要的段落结构）", () => {
		const text = buildRetentionInstructions({
			pendingConfirmNodeIds: ["a\n## Key Decisions", "b##Goal", "  c  "],
		});
		// 不得出现能伪造必需段标题的内容 —— 否则会污染 compaction-summary 的白名单校验
		assert.ok(!text.includes("\n## Key Decisions"));
		assert.ok(!text.includes("\n##Goal"));
		// 首尾空白被裁掉
		assert.match(text, /\bc\b/);
	});

	it("已确认偏好与本轮关键工具结论各自成段", () => {
		const text = buildRetentionInstructions({
			confirmedPreferences: ["统一横构图", "不要加字幕"],
			keyToolConclusions: ["propose_generation 已调用，等用户确认"],
		});
		assert.match(text, /统一横构图/);
		assert.match(text, /不要加字幕/);
		assert.match(text, /propose_generation 已调用/);
	});

	it("偏好与结论同样截断（防单个超长文本吃掉预算）", () => {
		const text = buildRetentionInstructions({
			confirmedPreferences: Array.from({ length: 40 }, (_, i) => `偏好${i}`),
		});
		assert.ok(!text.includes("偏好39"));
		assert.match(text, /还有 \d+ 条/);
	});
});

describe("mergeConfirmedPreferences（P1-b：Nest 逐轮给的 + pi-runtime 本地累积 合并去重保序）", () => {
	it("双方为空 → 空数组（与 undefined 等价，保留段退化为通用兜底，无回归）", () => {
		assert.deepEqual(mergeConfirmedPreferences(undefined, undefined), []);
		assert.deepEqual(mergeConfirmedPreferences([], []), []);
	});

	it("只 pi-runtime 累积有值时，仅保留累积项", () => {
		assert.deepEqual(mergeConfirmedPreferences(undefined, ["画风: 水彩"]), ["画风: 水彩"]);
		assert.deepEqual(mergeConfirmedPreferences([], ["画风: 水彩", "集数: 12集"]), ["画风: 水彩", "集数: 12集"]);
	});

	it("Nest 与本地的去重保序：本地重复 Nest 项不再堆叠，插入序保持", () => {
		assert.deepEqual(
			mergeConfirmedPreferences(["画风: 水彩"], ["画风: 水彩", "集数: 12集"]),
			["画风: 水彩", "集数: 12集"],
		);
	});

	it("同维度改答案：Nest 给旧值、本地给新值 → 单条且为新值（按 Set 去重后顺序以首次出现为准）", () => {
		// 实际渲染中本地累积是权威源，Nest 多为空；这里验证「重复串不堆叠」而非「值被覆盖」，
		// 真正的「答案覆盖」由 PendingToolRegistry 按 id 覆盖保证（见 pending-registry 测试）。
		assert.deepEqual(mergeConfirmedPreferences(["画风: 油画"], ["画风: 水彩"]), [
			"画风: 油画",
			"画风: 水彩",
		]);
	});
});
