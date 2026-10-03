import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { presentResult, SVG_MAX_CHARS } from "./present-result.js";

describe("presentResult", () => {
	it("把 payload 放进 details.canvasCommands（不是 content）", () => {
		const r = presentResult({ type: "svg_card", svg: "<svg/>" });
		assert.equal(r.details.ok, true);
		assert.equal(r.details.canvasCommands.length, 1);
		assert.equal(r.details.canvasCommands[0].type, "svg_card");
		// content 只是回显，真实载荷必须在 details
		assert.ok(r.content[0].text.includes("svg_card"));
	});

	it("svg 超上界时截断并置 truncated=true", () => {
		const long = "<svg>" + "x".repeat(SVG_MAX_CHARS) + "</svg>";
		const r = presentResult({ type: "svg_card", svg: long });
		assert.equal(r.details.truncated, true);
		assert.ok(r.details.canvasCommands[0].svg.length < long.length);
	});

	it("未超上界时不带 truncated 键", () => {
		const r = presentResult({ type: "svg_card", svg: "<svg/>" });
		assert.equal("truncated" in r.details, false);
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
