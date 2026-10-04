import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "./metrics.js";

/**
 * P0-3 收尾（L-2）：prompt version/hash 进指标（审计首轮 §04 P0-3 / Round 2 L-2）。
 *
 * ## 为什么必须有
 *
 * 首轮审计的原话：「线上出一次『假称已出图』事故，事后无法回答『那批请求用的是
 * 不是同一版提示词』，回溯链条断在最关键一环。」
 *
 * 现状：Nest 侧 `PromptManifest` 算了 `promptHash` / `registryVersion` / `registryHash`，
 * **但只喂给了 `this.logger.log()`** ⇒ 生产侧只有一行 Nest 日志，
 * 且「那一批请求」无法按版本聚合查询。
 *
 * ⚠️ 判「生产上用的是不是同一版提示词」需要**指标**（可聚合、可告警），
 * 只有日志是不够的 —— 日志无法回答「09:00–09:30 区间用的是哪版」。
 */
describe("pi_runtime_prompt_info（prompt 版本可观测，P0-3 / L-2）", () => {
	it("未设置时不输出样本行（Prometheus 语义：只出 HELP/TYPE）", () => {
		// ⚠️ 与 counter 型 Map 一致的口径：零流量时不谎报「当前是空版本」。
		// 谎报会让告警规则误以为「服务没配 prompt 版本」而永远 firing。
		const m = new Metrics();
		const text = m.render(0, "0.0.15");
		assert.ok(!text.includes("pi_runtime_prompt_info{"));
		assert.match(text, /# TYPE pi_runtime_prompt_info gauge/);
	});

	it("setPromptInfo 后输出 version + hash + registry 三元组", () => {
		const m = new Metrics();
		m.setPromptInfo({
			promptVersion: "2026.10.04-1",
			promptHash: "abc123def456",
			registryVersion: "1.0.0",
			registryHash: "9e8e28f11bc7",
		});
		const text = m.render(0, "0.0.15");
		assert.match(
			text,
			/pi_runtime_prompt_info\{promptVersion="2026\.10\.04-1",promptHash="abc123def456",registryVersion="1\.0\.0",registryHash="9e8e28f11bc7"\} 1/,
		);
	});

	it("⭐ 缺字段时用 n/a 而不是省略（标签集必须稳定，否则 Prometheus 里查不到）", () => {
		// 标签集随字段有无而变 ⇒ 同名指标有时 4 个标签、有时 2 个 ⇒ 查不出来。
		// 这正是首轮说的「观测上记为 n/a」的用意。
		const m = new Metrics();
		m.setPromptInfo({ promptVersion: "v1" });
		const text = m.render(0, "0.0.15");
		const line = text.split("\n").find((l) => l.startsWith("pi_runtime_prompt_info{"));
		assert.ok(line, "应输出样本行");
		assert.match(line, /promptVersion="v1"/);
		assert.match(line, /promptHash="n\/a"/);
		assert.match(line, /registryVersion="n\/a"/);
		assert.match(line, /registryHash="n\/a"/);
	});

	it("⭐ 值里的引号/反斜杠被转义（否则一个版本号里的 \" 就破 Prometheus 格式）", () => {
		const m = new Metrics();
		m.setPromptInfo({ promptVersion: 'v"1\\x', promptHash: "h" });
		const text = m.render(0, "0.0.15");
		const line = text.split("\n").find((l) => l.startsWith("pi_runtime_prompt_info{")) ?? "";
		assert.ok(line.includes('\\"'), `引号应被转义，实际：${line}`);
		assert.ok(line.includes("\\\\"), `反斜杠应被转义，实际：${line}`);
		// 转义后仍是一个完整的样本行（结尾是 "} 1"）
		assert.ok(line.trimEnd().endsWith("} 1"), `转义不应破坏结构，实际：${line}`);
	});

	it("后写的覆盖先写的（进程内只反映「当前这一版」，不是历史累积）", () => {
		// ⭐ 刻意**不做** counter累积：gauge 语义是「现在跑的是哪版」，
		// 与 build_info 同款。历史版本要查 git / Nest 日志，不该塞进 gauge。
		const m = new Metrics();
		m.setPromptInfo({ promptVersion: "v1", promptHash: "h1" });
		m.setPromptInfo({ promptVersion: "v2", promptHash: "h2" });
		const text = m.render(0, "0.0.15");
		const lines = text.split("\n").filter((l) => l.startsWith("pi_runtime_prompt_info{"));
		assert.equal(lines.length, 1, "gauge 只应有一行");
		assert.match(lines[0] ?? "", /promptVersion="v2"/);
	});
});
