import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { presentResult, SVG_MAX_CHARS } from "./present-result.js";

/** 解析 content 里的 JSON 摘要（content 恒为单条 text）。 */
function summary(r: ReturnType<typeof presentResult>): {
	ok: boolean;
	type: string;
	title?: string;
	bytes: number;
	truncated: boolean;
} {
	return JSON.parse(r.content[0].text);
}

describe("presentResult", () => {
	it("把 payload 放进 details.canvasCommands（不是 content）", () => {
		const r = presentResult({ type: "svg_card", svg: "<svg/>" });
		assert.equal(r.details.ok, true);
		assert.equal(r.details.canvasCommands.length, 1);
		assert.equal(r.details.canvasCommands[0].type, "svg_card");
		// content 只是摘要：带 type，但**不含 svg 本体**（否则模型要读整份载荷）
		assert.ok(r.content[0].text.includes("svg_card"));
		assert.ok(!r.content[0].text.includes("<svg"));
	});

	it("content 摘要带 bytes/truncated，且 ok 恒为 true", () => {
		const r = presentResult({ type: "svg_card", svg: "<svg/>", title: "拓扑" });
		const s = summary(r);
		assert.equal(s.ok, true);
		assert.equal(s.type, "svg_card");
		assert.equal(s.title, "拓扑");
		assert.equal(s.bytes, "<svg/>".length);
		assert.equal(s.truncated, false);
		// 载荷本体只在 details 里
		assert.equal(r.details.canvasCommands[0].svg, "<svg/>");
	});

	it("svg 超上界时整块丢弃并置 truncated=true", () => {
		const long = "<svg>" + "x".repeat(SVG_MAX_CHARS) + "</svg>";
		const r = presentResult({ type: "svg_card", svg: long });
		assert.equal(r.details.truncated, true);
		// 不做部分渲染：slice 会切断标签产出不可解析的 XML，故整块丢弃、前端降级 pre
		assert.equal(r.details.canvasCommands[0].svg, "");
		// ok 不复用为失败信号——工具本身成功，截断不是失败
		assert.equal(r.details.ok, true);
		assert.equal(summary(r).ok, true);
		assert.equal(summary(r).bytes, 0);
		assert.equal(summary(r).truncated, true);
	});

	it("未超上界时不带 truncated 键", () => {
		const r = presentResult({ type: "svg_card", svg: "<svg/>" });
		assert.equal("truncated" in r.details, false);
	});

	it("svg.length 恰等于上界时不截断（钉住 > 而非 >=）", () => {
		const exact = "x".repeat(SVG_MAX_CHARS);
		const r = presentResult({ type: "svg_card", svg: exact });
		assert.equal("truncated" in r.details, false);
		assert.equal(r.details.canvasCommands[0].svg.length, SVG_MAX_CHARS);
		assert.equal(summary(r).bytes, SVG_MAX_CHARS);
		assert.equal(summary(r).truncated, false);
	});

	it("annotations 透传且 severity 原样保留", () => {
		const r = presentResult({
			type: "svg_card",
			svg: "<svg/>",
			annotations: [{ nodeId: "n1", text: "超时长", severity: "warn" }],
		});
		assert.equal(r.details.canvasCommands[0].annotations?.[0].severity, "warn");
	});
});
