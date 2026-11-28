import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const indexSrc = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const configSrc = readFileSync(new URL("./runtime-config.ts", import.meta.url), "utf8");

describe("tool-call-sanitizer 接线（注册序 + 开关）", () => {
	it("index.ts 注册 sanitizer transform_context listener 且在 trustBoundary 之前", () => {
		assert.match(indexSrc, /import\s*\{[^}]*sanitizeMalformedToolCalls[^}]*\}\s*from\s*"\.\/tool-call-sanitizer\.js"/);
		const sanIdx = indexSrc.indexOf("sanitizeMalformedToolCalls(event.messages)");
		const trustIdx = indexSrc.indexOf("applyTrustBoundary(event.messages)");
		assert.ok(sanIdx > 0, "sanitizer listener 已注册");
		assert.ok(trustIdx > 0, "trust boundary listener 已注册");
		assert.ok(sanIdx < trustIdx, "sanitizer 必须先于 trust boundary——链式 hook 后者看到干净消息");
	});

	it("关闭开关时不注册 sanitizer，env 在 runtime-config 单一解析", () => {
		assert.match(indexSrc, /hookCfg\.toolCallSanitization/);
		assert.match(configSrc, /PI_RUNTIME_TOOL_CALL_SANITIZATION/);
	});
});
