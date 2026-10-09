/**
 * C3 接线落点锁定（index.ts 是模块级单例 + env 装配，无法 import 驱动 ⇒ 源文本断言）。
 * 行为本身由 session-manager.plan-gate.test.ts 用真实 harness 驱动
 * gate/plan-gate-wiring.ts 验证；本文件只锁「index.ts 真的调了接线 + onPrompt 清旗」，
 * 防止「测试绿、功能死」（测试测了函数但 index.ts 没接）。
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, "..", "index.ts"), "utf8");

test("index.ts 接线落点：plan-gate 三处接线齐备", () => {
	// ① 注册接线函数（真实 harness 行为的调用点）
	assert.match(indexSrc, /registerPlanGateHooks\(/, "index.ts 必须调用 registerPlanGateHooks");
	// ② 键域公式：canvasSessionId ?? sessionId（与 propose_plan tc.sessionId、播种 todoKey 同式）
	assert.match(indexSrc, /getCanvasSessionId\(sessionId\) \?\? sessionId/, "planKey 必须用 canvasSessionId ?? sessionId 公式");
	// ③ onPrompt 清 run 信号（新用户轮清执行信号，不动 pending）
	assert.match(indexSrc, /clearPlanRunFlag\(/, "onPrompt 必须清 plan run 信号");
	// ④ 接线在 nestClient 短路之前（纯文本模式也可用，与 config.ts 注册面一致）
	const wiringAt = indexSrc.indexOf("registerPlanGateHooks(");
	const nestShortCircuit = indexSrc.indexOf("if (!nestClient) return undefined;");
	assert.ok(wiringAt > -1 && nestShortCircuit > -1 && wiringAt < nestShortCircuit, "plan 接线必须挂在 if (!nestClient) 之前");
});
