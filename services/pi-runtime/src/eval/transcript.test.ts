import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldRuntimeEvents, type RuntimeEvent } from "./transcript.js";

/**
 * 流式事件 → 归一化 transcript 的折叠测试。
 *
 * ⭐ 本模块最容易出的错是**重复文本**（把全量重发当增量 append），
 * 那会让基于文本的断言永远失败 —— 一个「看起来在跑、实际判据全错」的评测基线，
 * 比没有 eval 更危险（它会让人根据错误的基线改提示词）。
 */
describe("foldRuntimeEvents（流式事件折叠）", () => {
	it("空事件流 → 空 transcript 且未完成", () => {
		const t = foldRuntimeEvents([]);
		assert.equal(t.assistantText, "");
		assert.deepEqual(t.toolNames, []);
		assert.equal(t.completed, false);
	});

	it("message_update 增量拼接", () => {
		const t = foldRuntimeEvents([
			{ type: "message_update", data: { text: "画一张" } },
			{ type: "message_update", data: { text: "夜景" } },
		]);
		assert.equal(t.assistantText, "画一张夜景");
	});

	it("⭐ message_end 全量重发 ⇒ 替换而非追加（否则同一段话出现两遍）", () => {
		const t = foldRuntimeEvents([
			{ type: "message_update", data: { text: "画一张夜景" } },
			// vendor 的 message_end 常带全量文本
			{ type: "message_end", data: { text: "画一张夜景" } },
		]);
		assert.equal(t.assistantText, "画一张夜景");
		assert.equal(
			t.assistantText.split("画一张夜景").length - 1,
			1,
			"「画一张夜景」必须只出现一次",
		);
	});

	it("全量重发且内容增长（旧文本是新文本前缀）⇒ 替换", () => {
		const t = foldRuntimeEvents([
			{ type: "message_end", data: { text: "画一张" } },
			{ type: "message_end", data: { text: "画一张夜景，已建好节点。" } },
		]);
		assert.equal(t.assistantText, "画一张夜景，已建好节点。");
	});

	it("block 数组形态的 content 也被抽出", () => {
		const t = foldRuntimeEvents([
			{
				type: "message_end",
				data: { content: [{ type: "text", text: "你好" }, { type: "text", text: "世界" }] },
			},
		]);
		assert.equal(t.assistantText, "你好世界");
	});

	it("tool_execution_start 按顺序记工具名", () => {
		const t = foldRuntimeEvents([
			{ type: "tool_execution_start", data: { toolName: "upsert_media_node" } },
			{ type: "tool_execution_start", data: { toolName: "propose_generation" } },
		]);
		assert.deepEqual(t.toolNames, ["upsert_media_node", "propose_generation"]);
	});

	it("⭐ 同一 callId 重放 ⇒ 去重（断线重连会重发）", () => {
		const t = foldRuntimeEvents([
			{ type: "tool_execution_start", data: { toolName: "upsert_media_node", toolCallId: "c1" } },
			// 重连重放：同 callId
			{ type: "tool_execution_start", data: { toolName: "upsert_media_node", toolCallId: "c1" } },
		]);
		assert.deepEqual(t.toolNames, ["upsert_media_node"], "同 callId 应去重为一次");
	});

	it("⭐ 同名不同 callId ⇒ 保留两次（真实的一轮里可以调多次）", () => {
		const t = foldRuntimeEvents([
			{ type: "tool_execution_start", data: { toolName: "set_node_text", toolCallId: "c1" } },
			{ type: "tool_execution_start", data: { toolName: "set_node_text", toolCallId: "c2" } },
		]);
		assert.deepEqual(t.toolNames, ["set_node_text", "set_node_text"]);
	});

	it("记录工具入参（供断言「调了但参数对不对」）", () => {
		const t = foldRuntimeEvents([
			{
				type: "tool_execution_start",
				data: { toolName: "propose_generation", toolCallId: "c1", input: { nodeId: "n1" } },
			},
		]);
		assert.equal(t.toolCalls[0]?.name, "propose_generation");
		assert.deepEqual(t.toolCalls[0]?.input, { nodeId: "n1" });
	});

	it("agent_end(completed) + 无 error ⇒ completed", () => {
		const t = foldRuntimeEvents([
			{ type: "message_end", data: { text: "好了" } },
			{ type: "agent_end", data: { status: "completed" } },
		]);
		assert.equal(t.completed, true);
	});

	it("⭐ 有 error 事件 ⇒ completed=false（哪怕 agent_end 说 completed）", () => {
		const t = foldRuntimeEvents([
			{ type: "error", data: { message: "upstream 503" } },
			{ type: "agent_end", data: { status: "completed" } },
		]);
		assert.equal(t.completed, false);
		assert.deepEqual(t.errors, ["upstream 503"]);
	});

	it("agent_end 非 completed（aborted/deferred）⇒ completed=false", () => {
		for (const status of ["aborted", "deferred", "failed"]) {
			const t = foldRuntimeEvents([{ type: "agent_end", data: { status } }]);
			assert.equal(t.completed, false, `${status} 不应算完成`);
		}
	});

	it("usage 事件被采集（供 token 成本对比）", () => {
		const t = foldRuntimeEvents([
			{ type: "usage", data: { usage: { input: 100, output: 50, total: 150 } } },
			{ type: "agent_end", data: { status: "completed" } },
		]);
		assert.deepEqual(t.usage, { input: 100, output: 50, total: 150 });
	});

	it("未知事件类型被忽略（向前兼容，不因新事件崩掉）", () => {
		const t = foldRuntimeEvents([
			{ type: "brand_new_event_from_vendor", data: { whatever: true } },
			{ type: "message_end", data: { text: "ok" } },
			{ type: "agent_end", data: { status: "completed" } },
		]);
		assert.equal(t.assistantText, "ok");
		assert.equal(t.completed, true);
	});
});


describe("⭐ foldRuntimeEvents：生产实测载荷（2026-10-04 校正）", () => {
	/**
	 * ⭐⭐ 这组是用**生产真实事件**写的回归测试。
	 *
	 * 起因：首次真跑 L1 时发现 `assistantText`恒为空 —— 原`extractText`读
	 * `data.text` / `data.content`，而生产载荷是 `data.message.content[].text`。
	 * ⇒ 所有 `forbidText` 判据**永远假绿**。
	 *
	 * 这类缺陷单测抓不到：原测试用的 `data: { text: "..." }` 是**我们自己臆造的形态**，
	 * 与生产不符。⇒ **判据层的事件形态必须来自生产取证，不能自造。**
	 */

	const REAL_ASSISTANT_END = {
		type: "message_end",
		seq: 62,
		ts: 1791097911000,
		data: {
			type: "message_end",
			lane: "main",
			runId: "01a105c1-3484-77cf-b575-3717c22b0f2a",
			message: {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: 'The user is saying "谢谢，辛苦了" (Thank you). This is a simple expression of gratitude, not a task request. I should reply briefly.',
					},
					{ type: "text", text: "\n\n不客气！如有其他需要，随时找我。😊" },
				],
				timestamp: 1791097911000,
			},
		},
	} as const;

	it("⭐ 从 data.message.content[].text 取助手文本（原实现恒返回空）", () => {
		const t = foldRuntimeEvents([REAL_ASSISTANT_END]);
		assert.match(t.assistantText, /不客气/, `应取到助手文本，实际="${t.assistantText}"`);
		assert.notEqual(t.assistantText, "", "assistantText 不得为空（原缺陷：恒空 ⇒ 文本判据全假绿）");
	});

	it("⭐⭐ 过滤 thinking 块：模型内心戏不得当成交付文本", () => {
		const t = foldRuntimeEvents([REAL_ASSISTANT_END]);
		assert.equal(
			t.assistantText.includes("gratitude"),
			false,
			`thinking 内容不得混入 assistantText（否则 forbidText 判据误判）：${t.assistantText}`,
		);
		assert.equal(t.assistantText.includes("simple expression"), false);
	});

	it("user 角色的 message_end 不污染助手文本", () => {
		// 实测事件流里第一个 message_end 是 user 的回显
		const userEnd = {
			type: "message_end",
			data: { type: "message_end", lane: "main", message: { role: "user", content: [{ type: "text", text: "谢谢，辛苦了" }] } },
		} as const;
		const t = foldRuntimeEvents([userEnd, REAL_ASSISTANT_END]);
		assert.equal(t.assistantText.includes("谢谢，辛苦了"), false, "user 文本不应算成助手输出");
		assert.match(t.assistantText, /不客气/);
	});

	it("⭐ 真实完整事件流：fold 到底能拿到完整助手文本", () => {
		// 实测序列（2026-10-04 生产）：agent_start → message_end(user) →
		// turn_start → 50× message_update → message_end(assistant) → turn_end → agent_end
		const flow = [
			{ type: "agent_start", data: { type: "run_start", runId: "r1", lane: "main" } },
			{ type: "message_end", data: { message: { role: "user", content: [{ type: "text", text: "谢谢，辛苦了" }] } } },
			{ type: "turn_start", data: { type: "turn_start", turnId: "t1" } },
			...Array.from({ length: 50 }, () => ({
				type: "message_update",
				data: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "不" }] } },
			})),
			REAL_ASSISTANT_END,
			{ type: "turn_end", data: { type: "turn_end" } },
			{ type: "agent_end", data: { type: "run_end", status: "completed" } },
		];
		const t = foldRuntimeEvents(flow);
		assert.match(t.assistantText, /不客气/, "应拿到最终完整文本");
		assert.equal(t.completed, true, "agent_end(completed) 且无 error ⇒ completed");
		assert.deepEqual(t.errors, []);
	});

	it("completed 判定容忍 run_end 的数据形态（实测 status 在 data.status）", () => {
		// 实测：agent_end 的 data 是 `{type:"run_end", status:"completed", ...}`
		// —— 若只看 data.type 会误判成非 completed
		const t = foldRuntimeEvents([{ type: "agent_end", data: { type: "run_end", status: "completed" } }]);
		assert.equal(t.completed, true);
	});
});


describe("⭐⭐ foldRuntimeEvents：生产实测的流式累积快照（2026-10-04）", () => {
	/**
	 * ⭐⭐ 这是评测里**最隐蔽**的一类假绿：折叠出来的 `assistantText`
	 * 是阶梯状重复，而**基于文本的判据（forbidText/expectTextIncludes）
	 * 仍然「通过」** ⇒ 基线看起来正常，实际文本完全失真。
	 *
	 * 实测数据（话术「先别画了，我改主意了」，真实画布 + 真实规则集）：
	 * 132 个 `message_update`，而 transcript 里的 assistantText 是
	 * `"好的，\n好的，当前\n好的，当前画\n好的，当前画布\n…"`
	 *（同一句话被追加了 17 次）—— 而模型实际只说了一句。
	 *
	 * 根因：`message_update` 带的是**累积快照**（当前全文），
	 * 而 `mergeText` 的「真增量」分支把每次都**追加**了。
	 */
	function snapshot(text: string) {
		return {
			type: "message_update",
			data: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } },
		};
	}
	const FINAL = {
		type: "message_end",
		data: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "好的，当前画布上只有两个提示词节点。" }] } },
	} as const;

	it("⭐ 累积快照序列不得产生阶梯重复", () => {
		// 复刻实测形态：每步都是「到目前为止的全文」
		const growing = ["好", "好的", "好的，", "好的，当前", "好的，当前画布", "好的，当前画布上只有两个提示词节点。"];
		const t = foldRuntimeEvents([...growing.map(snapshot), FINAL]);
		assert.equal(
			t.assistantText,
			"好的，当前画布上只有两个提示词节点。",
			`assistantText 必须是最终全文，实际="${t.assistantText}"`,
		);
		assert.equal(
			t.assistantText.indexOf("好的，当前画布上"),
			t.assistantText.lastIndexOf("好的，当前画布上"),
			"同一段不得出现两次",
		);
	});

	it("⭐ message_end 权威替换：即使与快照不一致也不留残留", () => {
		// 场景：最后一块 message_end 只含尾部（与累积快照不一致）
		const t = foldRuntimeEvents([snapshot("前面一段残留。"), FINAL]);
		assert.equal(
			t.assistantText,
			"好的，当前画布上只有两个提示词节点。",
			`message_end 应替换掉之前的残留，实际="${t.assistantText}"`,
		);
		assert.equal(t.assistantText.includes("前面一段残留"), false, "不该保留旧块的文本");
	});

	it("⭐ 多轮对话：最后一条 message_end 胜出", () => {
		const t = foldRuntimeEvents([
			snapshot("第一轮回答"),
			FINAL,
			snapshot("第二轮回答草稿"),
			{
				type: "message_end",
				data: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第二轮最终回答" }] } },
			},
		]);
		assert.equal(t.assistantText, "第二轮最终回答", "应取最后一条 message_end");
	});

	it("⚠️ 连续两次相同快照不应重复（幂等）", () => {
		const one = snapshot("一样的文本");
		const t = foldRuntimeEvents([one, one, one]);
		assert.equal(t.assistantText, "一样的文本");
	});
});
