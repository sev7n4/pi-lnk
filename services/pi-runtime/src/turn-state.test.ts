import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildTurnState,
	describeInterruption,
	normalizeSteps,
	parseTurnState,
	renderTurnStateBlock,
	renderTurnStateGuidance,
	truncateText,
	turnStateProjector,
	TURN_STATE_CUSTOM_TYPE,
	type InterruptionKind,
} from "./turn-state.js";

describe("truncateText（截断保留首尾）", () => {
	it("短文本原样返回", () => {
		assert.equal(truncateText("  hello  "), "hello");
	});

	it("超长文本头尾都保留，中间省略", () => {
		const long = "A".repeat(2000);
		const out = truncateText(long, 100);
		assert.ok(out.length <= 100, `实际 ${out.length}`);
		assert.ok(out.includes("..."), "应有省略标记");
		assert.ok(out.startsWith("A"), "应保留开头");
		assert.ok(out.endsWith("A"), "应保留结尾（最接近故障点的信息）");
	});

	it("空串不炸", () => {
		assert.equal(truncateText(""), "");
		assert.equal(truncateText(undefined as unknown as string), "");
	});
});

describe("normalizeSteps（步骤列表归一）", () => {
	it("去空白项、截断条数", () => {
		const steps = ["  a  ", "", "b", "   ", "c"];
		assert.deepEqual(normalizeSteps(steps), ["a", "b", "c"]);
	});

	it("undefined/空数组返回空", () => {
		assert.deepEqual(normalizeSteps(undefined), []);
		assert.deepEqual(normalizeSteps([]), []);
	});

	it("超过上限时截断", () => {
		const many = Array.from({ length: 50 }, (_, i) => `step-${i}`);
		assert.equal(normalizeSteps(many, 3).length, 3);
	});
});

describe("buildTurnState（构造，不冒充知道）", () => {
	it("字段按契约归一", () => {
		const state = buildTurnState({
			userText: "让他们抱在一起",
			assistantPartial: "好的，我先读取画布",
			interruption: "upstream_error",
			completedSteps: ["已读画布"],
			pendingSteps: ["调用 run_image_generation"],
			at: 1_700_000_000_000,
		});
		assert.equal(state.userText, "让他们抱在一起");
		assert.equal(state.interruption, "upstream_error");
		assert.deepEqual(state.completedSteps, ["已读画布"]);
		assert.deepEqual(state.pendingSteps, ["调用 run_image_generation"]);
	});

	it("未提供 assistantPartial 时为空串（不编造半截输出）", () => {
		const state = buildTurnState({
			userText: "x",
			interruption: "transport_failed",
			at: 1,
		});
		assert.equal(state.assistantPartial, "");
	});
});

describe("renderTurnStateBlock（注入模型上下文的措辞纪律）", () => {
	const state = buildTurnState({
		userText: "让他们抱在一起",
		assistantPartial: "我先看一下画布",
		interruption: "upstream_error",
		completedSteps: ["已读取画布摘要"],
		pendingSteps: ["合成两个角色的图片"],
		at: 1_700_000_000_000,
	});
	const block = renderTurnStateBlock(state);

	it("含用户原始请求（模型据此知道要继续什么）", () => {
		assert.ok(block.includes("让他们抱在一起"), block);
	});

	it("含已完成与未完成步骤", () => {
		assert.ok(block.includes("已读取画布摘要"), block);
		assert.ok(block.includes("合成两个角色的图片"), block);
	});

	it("⛔ 指导指令不得让模型靠观察画布来反推用户意图（本次事故形态）", () => {
		// 判据落在**指导指令**上，而非整块文本：状态事实里出现「画布」是正常的
		// （已完成步骤可能就是「已读取画布摘要」），真正要禁的是
		// 「用观察画布来反推用户想要什么」这条推理路径。
		const guidance = renderTurnStateGuidance(state);
		assert.ok(!guidance.includes("画布"), guidance);
		assert.ok(!guidance.includes("推测"), guidance);
		assert.ok(!guidance.includes("猜测"), guidance);
	});

	it("✅ 指导指令给出「不要重新推断」的正面指令（替代禁词）", () => {
		assert.ok(renderTurnStateGuidance(state).includes("不要重新推断"));
	});

	it("⛔ 指导指令不得道歉/复盘（对齐 WorkBuddy 'no apology, no recap'）", () => {
		const guidance = renderTurnStateGuidance(state);
		assert.ok(!guidance.includes("抱歉"), guidance);
		assert.ok(!guidance.includes("对不起"), guidance);
	});

	it("✅ 指导指令禁止重复已完成步骤", () => {
		assert.ok(renderTurnStateGuidance(state).includes("不要重复已经完成的步骤"));
	});

	it("⛔ 不得指示重复已完成步骤", () => {
		assert.ok(block.includes("不要重复已经完成的步骤"), block);
	});

	it("无 pendingSteps 时显式说「未知」而不是留空", () => {
		const noPending = renderTurnStateBlock(
			buildTurnState({ userText: "y", interruption: "unknown", at: 1 }),
		);
		assert.ok(noPending.includes("未知"), noPending);
	});
});

describe("describeInterruption（中断类型人话）", () => {
	it("覆盖全部枚举值", () => {
		const kinds: InterruptionKind[] = [
			"upstream_error",
			"tool_interrupted",
			"session_busy",
			"transport_failed",
			"history_diverged",
			"unknown",
		];
		for (const k of kinds) {
			assert.equal(typeof describeInterruption(k), "string");
			assert.notEqual(describeInterruption(k), "");
		}
	});
});

describe("turnStateProjector（上游 EntryProjector）", () => {
	it("投影 lnkpi.turn_state 自定义条目为 user 消息", () => {
		const state = buildTurnState({
			userText: "让他们抱在一起",
			interruption: "history_diverged",
			pendingSteps: ["合成图片"],
			at: 1,
		});
		const out = turnStateProjector({
			type: "custom",
			customType: TURN_STATE_CUSTOM_TYPE,
			data: state,
		});
		assert.ok(out, "应投影出消息");
		assert.equal(out!.length, 1);
		assert.equal(out![0].role, "user");
		assert.ok(out![0].content.includes("让他们抱在一起"));
	});

	it("⭐ user 角色 + 无 stopReason ⇒ 不会被上游 isContextMessage 过滤", () => {
		const out = turnStateProjector({
			type: "custom",
			customType: TURN_STATE_CUSTOM_TYPE,
			data: buildTurnState({ userText: "z", interruption: "unknown", at: 1 }),
		});
		assert.ok(out);
		// 上游 isContextMessage 只过滤 assistant 的 error/aborted/deferred；
		// user 角色 + 无 stopReason ⇒ 恒进上下文。
		assert.equal((out![0] as { stopReason?: string }).stopReason, undefined);
		assert.equal(out![0].role, "user");
	});

	it("非本类型条目不投影", () => {
		assert.equal(turnStateProjector({ type: "custom", customType: "other" }), undefined);
	});

	it("坏数据不投影（不冒充知道）", () => {
		assert.equal(
			turnStateProjector({ type: "custom", customType: TURN_STATE_CUSTOM_TYPE, data: null }),
			undefined,
		);
		assert.equal(
			turnStateProjector({ type: "custom", customType: TURN_STATE_CUSTOM_TYPE, data: { nope: 1 } }),
			undefined,
		);
	});
});

describe("parseTurnState（容错解析）", () => {
	it("解析合法状态", () => {
		const parsed = parseTurnState({
			userText: "a",
			assistantPartial: "b",
			interruption: "tool_interrupted",
			completedSteps: ["c1"],
			pendingSteps: ["p1"],
			at: 42,
		});
		assert.ok(parsed);
		assert.equal(parsed!.interruption, "tool_interrupted");
		assert.equal(parsed!.at, 42);
	});

	it("未知 interruption 降级为 unknown（不猜）", () => {
		const parsed = parseTurnState({ userText: "a", interruption: "weird_kind" });
		assert.ok(parsed);
		assert.equal(parsed!.interruption, "unknown");
	});

	it("缺 userText ⇒ undefined（整条不投影）", () => {
		assert.equal(parseTurnState({ assistantPartial: "x" }), undefined);
		assert.equal(parseTurnState({ userText: 123 }), undefined);
	});

	it("非对象 ⇒ undefined", () => {
		assert.equal(parseTurnState("str"), undefined);
		assert.equal(parseTurnState(undefined), undefined);
	});

	it("非字符串的步骤被丢弃而不是当成字符串用", () => {
		const parsed = parseTurnState({ userText: "a", completedSteps: ["ok", 42, null] });
		assert.ok(parsed);
		assert.deepEqual(parsed!.completedSteps, ["ok"]);
	});
});
