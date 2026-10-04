import assert from "node:assert/strict";
import { test } from "node:test";
import { INFLIGHT_TTL_MS, SETTLED_MAX, ToolMetrics } from "./tool-metrics.js";

const base = {
	toolName: "add_node",
	channel: "agnes",
	model: "agnes-2.5-flash",
	resultText: "ok",
};

function collect(tm: ToolMetrics): string {
	const lines: string[] = [];
	tm.renderInto(lines);
	return lines.join("\n");
}

test("start + end 正常配对：计数 1、result=ok、记录耗时", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "c1" });
	tm.observeEnd({ ...base, toolCallId: "c1", isError: false, terminate: false });
	const out = collect(tm);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="add_node",result="ok"\} 1/);
	assert.match(out, /pi_runtime_tool_duration_seconds_count\{tool="add_node"\} 1/);
	// `ended` 语义：已见 end 的唯一 toolCallId 数（含孤儿），不是「结算次数」
	assert.equal(tm.stats().ended, 1);
});

test("孤儿 end（无 start）：只计数、不产生时长、且不抛错", () => {
	const tm = new ToolMetrics();
	assert.doesNotThrow(() => tm.observeEnd({ ...base, toolCallId: "orphan", isError: false, terminate: false }));
	const out = collect(tm);
	assert.match(out, /pi_runtime_tool_calls_total\{tool="add_node",result="ok"\} 1/);
	assert.equal(out.includes("tool_duration_seconds_count"), false, "孤儿事件污染了时长直方图");
	assert.equal(tm.stats().orphaned, 1);
});

test("同一 toolCallId 重复 end：幂等，不二次计数（断线重放场景）", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "dup" });
	tm.observeEnd({ ...base, toolCallId: "dup", isError: false, terminate: false });
	tm.observeEnd({ ...base, toolCallId: "dup", isError: false, terminate: false });
	assert.match(collect(tm), /pi_runtime_tool_calls_total\{tool="add_node",result="ok"\} 1/);
	assert.equal(tm.stats().duplicates, 1);
});

// ---- ④ settled 命名误导 ----

test("孤儿 end 也计入 ended：字段语义是「已见 end 的唯一 id 数」而非「结算次数」", () => {
	const tm = new ToolMetrics();
	tm.observeEnd({ ...base, toolCallId: "orph", isError: false, terminate: false });
	const s = tm.stats();
	// 孤儿 end 没有配对 start，故不记时长；但它确实已见 end ⇒ 计入 ended。
	assert.equal(s.ended, 1, "孤儿 end 未计入 ended");
	assert.equal(s.orphaned, 1);
	// 「结算次数」若按字面理解应为 0，这正是原注释与实际行为相反之处。
	assert.notEqual(s.ended, 0);
});

// ---- ② inflight / settled 无界增长 ----

test("recovery 重放成对 start→end 后，inflight 无残留", () => {
	const tm = new ToolMetrics();
	// 第一次结算：配对完整，inflight 应清空
	tm.observeStart({ toolCallId: "r1" });
	tm.observeEnd({ ...base, toolCallId: "r1", isError: false, terminate: false });
	assert.equal(tm.inflightSizeForTest(), 0, "正常配对后 inflight 应为空");

	// recovery 重放同一对 start→end：第二个 end 撞幂等早退
	tm.observeStart({ toolCallId: "r1" });
	tm.observeEnd({ ...base, toolCallId: "r1", isError: false, terminate: false });

	// 回归点：早退前若不清理 inflight，第二次 start 塞的条目永久残留（实测 size=1）
	assert.equal(tm.inflightSizeForTest(), 0, "重放后 inflight 残留 ⇒ 内存泄漏");
	assert.equal(tm.stats().duplicates, 1);
	assert.equal(tm.stats().orphaned, 0, "重放不应被误判为孤儿");
});

test("连续重放 1000轮，inflight 仍不增长", () => {
	const tm = new ToolMetrics();
	for (let i = 0; i < 1000; i++) {
		tm.observeStart({ toolCallId: "loop" });
		tm.observeEnd({ ...base, toolCallId: "loop", isError: false, terminate: false });
	}
	assert.equal(tm.inflightSizeForTest(), 0);
	// 第 1 轮是正常结算，第 2..1000 轮才是重放 ⇒ 999 次重复
	assert.equal(tm.stats().duplicates, 999);
	assert.equal(tm.stats().orphaned, 0, "重放不应被误判为孤儿");
	assert.equal(tm.stats().ended, 1, "重放不产生新的唯一 id");
});

test("只有 start 没有 end（工具崩溃/lane abandon）：渲染时按 TTL 清扫，不无界增长", () => {
	const tm = new ToolMetrics();
	// 模拟 100 个孤儿 start，**不**调 observeEnd
	for (let i = 0; i < 100; i++) tm.observeStart({ toolCallId: `crash-${i}` });
	assert.equal(tm.inflightSizeForTest(), 100, "清扫前应全部在 inflight");

	// 关键：清扫只发生在 renderInto。若观察后立刻断言，条目还在——
	// 这证明"清扫由渲染路径触发"这一实现选择被测试锁住。
	collect(tm);
	assert.equal(tm.inflightSizeForTest(), 100, "未过 TTL 不应被清（660s 上限内仍在跑）");

	// 把某条的时间戳改到 TTL 之外，模拟久远的孤儿条目
	(tm as unknown as { inflight: Map<string, number> }).inflight.set("crash-0", Date.now() - INFLIGHT_TTL_MS - 1000);
	collect(tm);
	assert.equal(tm.inflightSizeForTest(), 99, "超 TTL 的孤儿条目应被回收");

	// 全部过期 ⇒ 清空
	const inflight = (tm as unknown as { inflight: Map<string, number> }).inflight;
	for (const [k, v] of inflight) inflight.set(k, Date.now() - INFLIGHT_TTL_MS - 1000);
	collect(tm);
	assert.equal(tm.inflightSizeForTest(), 0, "全部过期后应清空");
});

test("settled 有界：塞入远超上限的 id 后 size 不再增长（防慢性OOM）", () => {
	const tm = new ToolMetrics();
	const total = SETTLED_MAX + 500;
	for (let i = 0; i < total; i++) {
		// 孤儿 end：最省路径，且都能进 settled
		tm.observeEnd({ ...base, toolCallId: `c-${i}`, isError: false, terminate: false });
	}
	assert.equal(tm.settledSizeForTest(), SETTLED_MAX, `settled 应封顶在 ${SETTLED_MAX}，实际 ${tm.settledSizeForTest()}`);

	// 继续灌：size 不得再涨
	for (let i = 0; i < 2000; i++) {
		tm.observeEnd({ ...base, toolCallId: `d-${i}`, isError: false, terminate: false });
	}
	assert.equal(tm.settledSizeForTest(), SETTLED_MAX, "settled 越过上限后仍在增长 ⇒ 无界");

	// 计数不受回收影响（回收的是幂等键，不是计数器）
	assert.equal(tm.stats().orphaned, total + 2000);
});

test("有界化的语义取舍：被淘汰的旧 id 若重放，会被二次计数", () => {
	// 这是刻意的取舍（见 SETTLED_MAX 注释）：内存有界 vs 极旧重放可能重复计数。
	// 本测试把该语义**显式锁住**，避免后人误以为是 bug 而"修"回去。
	const tm = new ToolMetrics();
	const early = "to-be-evicted";
	tm.observeEnd({ ...base, toolCallId: early, isError: false, terminate: false });
	// 灌满窗口：early 作为最早插入者被淘汰
	for (let i = 0; i < SETTLED_MAX; i++) {
		tm.observeEnd({ ...base, toolCallId: `f-${i}`, isError: false, terminate: false });
	}
	assert.equal(tm.settledSizeForTest(), SETTLED_MAX);

	// early 已不在幂等窗口内 ⇒ 重放会被再计一次（duplicates 不增）
	const orphansBefore = tm.stats().orphaned;
	tm.observeEnd({ ...base, toolCallId: early, isError: false, terminate: false });
	assert.equal(tm.stats().duplicates, 0, "被淘汰的 id 不应被判为重复");
	assert.equal(tm.stats().orphaned, orphansBefore + 1, "被淘汰的 id 重放应被再计一次（刻意取舍）");

	// 窗口内最新的 id 仍受幂等保护（不因有界化而失效）
	tm.observeEnd({ ...base, toolCallId: `f-${SETTLED_MAX - 1}`, isError: false, terminate: false });
	assert.equal(tm.stats().duplicates, 1, "窗口内 id 的幂等保护应仍然有效");
});

test("error 时附error_class label", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "e1" });
	tm.observeEnd({ ...base, toolCallId: "e1", isError: true, terminate: false, resultText: "HTTP 429 rate limit" });
	assert.match(collect(tm), /result="error",error_class="upstream_4xx"\} 1/);
});

test("terminate 归 blocked 而非 error", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "b1" });
	tm.observeEnd({ ...base, toolCallId: "b1", isError: false, terminate: true });
	assert.match(collect(tm), /result="blocked",error_class="blocked_terminate"\} 1/);
});

test("LLM 指标带 channel 与 model 标签", () => {
	const tm = new ToolMetrics();
	tm.observeLlmError({ stage: "main_turn", errorClass: "upstream_5xx", channel: "byok-abc123def456", model: "gpt-4o" });
	const out = collect(tm);
	assert.match(out, /pi_runtime_llm_errors_total\{stage="main_turn",error_class="upstream_5xx",channel="byok-abc123def456",model="gpt-4o"\} 1/);
});

test("渲染含 HELP 与 TYPE 行", () => {
	const out = collect(new ToolMetrics());
	assert.match(out, /# HELP pi_runtime_tool_calls_total/);
	assert.match(out, /# TYPE pi_runtime_tool_calls_total counter/);
	assert.match(out, /# TYPE pi_runtime_tool_duration_seconds histogram/);
});

test("错误原文不出现在任何渲染行中", () => {
	const tm = new ToolMetrics();
	tm.observeStart({ toolCallId: "s1" });
	tm.observeEnd({ ...base, toolCallId: "s1", isError: true, terminate: false, resultText: "sk-live-SECRET123 invalid" });
	assert.equal(collect(tm).includes("sk-live-SECRET123"), false);
});

// ---- ③文本格式注入（label 值含 \n 可伪造独立指标行）----

test("model 含换行：不得渲染出伪造的独立指标行", () => {
	// 现实注入点：model 来自用户 BYOK 的 override.model，
	// llm-override.ts:45 只校验 nonEmptyString，允许任意字符串。
	const tm = new ToolMetrics();
	tm.observeLlmError({
		stage: "main_turn",
		errorClass: "upstream_5xx",
		channel: "byok-abc123def456",
		model: 'gpt-4o"} 1\npi_runtime_FAKE 999\nx="',
	});
	const out = collect(tm);
	// 转义生效的判据是「FAKE 不是独立的一行」——文本子串仍会存在（它是 label 值的一部分），
	// 但它必须被 \\n 压在同一行内。
	assert.equal(/^pi_runtime_FAKE 999$/m.test(out), false, "换行注入伪造出了独立指标行");
	// 转义后应是字面量 \n 两个字符，仍在同一行内
	assert.match(out, /model="gpt-4o\\"\} 1\\npi_runtime_FAKE 999\\nx=\\""/);
	// 每一行都必须是合法样本行：不得有裸的 pi_runtime_FAKE 开头行
	assert.equal(/^pi_runtime_FAKE/m.test(out), false);
});

test("toolName 含换行：不得污染 tool_calls_total 与 duration 直方图", () => {
	const tm = new ToolMetrics();
	const evil = 'add_node"} 1\npi_runtime_FAKE2 888\nx="';
	tm.observeStart({ toolCallId: "i1" });
	tm.observeEnd({ ...base, toolName: evil, toolCallId: "i1", isError: false, terminate: false });
	const out = collect(tm);
	assert.equal(/^pi_runtime_FAKE2 888$/m.test(out), false, "toolName 换行注入伪造出了独立指标行");
	assert.equal(/^pi_runtime_FAKE2/m.test(out), false);
	// 仍是一个合法的 tool_calls_total 样本行
	assert.match(out, /pi_runtime_tool_calls_total\{tool="add_node\\"\} 1\\npi_runtime_FAKE2 888\\nx=\\"",result="ok"\} 1/);
});

test("errorClass label 含换行：不得伪造指标行", () => {
	// 走 LLM 重试通道，其 label 含 errorClass/channel/model 三个可注入位
	const tm = new ToolMetrics();
	tm.observeLlmRetry({
		stage: "main_turn",
		channel: "chan\npi_runtime_FAKE4 1",
		model: "m",
	});
	const out = collect(tm);
	assert.equal(/^pi_runtime_FAKE4/m.test(out), false, "channel 换行注入伪造出了独立指标行");
});

test("回车与反斜杠同样被转义（文本格式要求）", () => {
	const tm = new ToolMetrics();
	tm.observeLlmError({ stage: "main_turn", errorClass: "upstream_5xx", channel: "c", model: "a\rb\\c" });
	const out = collect(tm);
	// \r 同样是行分隔符，必须转义
	assert.equal(/^pi_runtime_[A-Z]/m.test(out.split("model=\"")[2] ?? ""), false, "\\r 未被转义");
	assert.match(out, /model="a\\rb\\\\c"/);
});

test("所有渲染行都通过 Prometheus 样本行形状校验（无裸换行注入）", () => {
	// 通用防线：对全部 4 个指标族灌入带 \n 的恶意 label。
	const tm = new ToolMetrics();
	const evil = 'x\npi_runtime_EVIL 1\ny="';
	tm.observeStart({ toolCallId: "v1" });
	tm.observeEnd({ ...base, toolName: evil, toolCallId: "v1", isError: false, terminate: false });
	tm.observeLlmError({ stage: "main_turn", errorClass: "upstream_5xx", channel: evil, model: evil });
	tm.observeLlmRetry({ stage: "main_turn", channel: evil, model: evil });
	const lines: string[] = [];
	tm.renderInto(lines);

	// 关键不变量（变异验证实测：早期版本用 `/\{[^}]*\}/` 逐行校验，
	// 但 `[^}]` 本身能匹配换行 ⇒ 注入行仍被判为合法，测试无法证伪）：
	// renderInto 每次 push 恰好一个样本行，故**按 \n 切分后的行数必须等于 push 次数**。
	// 只要有任何 label 注入裸 \n 或 \r，切分行数就会多于 push 次数。
	const split = lines.join("\n").split("\n");
	assert.equal(split.length, lines.length, `注入导致行数膨胀：push ${lines.length} 行，实际切出 ${split.length} 行`);

	for (const line of lines) {
		if (line.startsWith("#") || line.trim() === "") continue;
		// label 值内不得含裸换行/回车（注意 [^}] 也能匹配 \n，必须显式排除）
		assert.match(line, /^pi_runtime_[a-z_]+(\{[^{}\n\r]*\})? -?[\d.]+(e[+-]\d+)?$/, `非法样本行: ${JSON.stringify(line)}`);
	}
	assert.equal(lines.filter((l) => l.startsWith("pi_runtime_EVIL")).length, 0);
});
