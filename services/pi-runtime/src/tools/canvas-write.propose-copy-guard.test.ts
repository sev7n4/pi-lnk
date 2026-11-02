/**
 * propose 结算文案守卫（A2，2026-11-02 老黄牛死循环护栏，RCA v2 §5 验收 4）。
 *
 * 背景：timeout 结算的「请等待用户后续指示」+ 信号行「重试同参无意义，请调整参数后重试」、
 * stale_status 结算的「请重新 propose_generation」，共同构成死循环文本燃料（模型照办重提议
 * ×5，每轮阻塞 5min）。本守卫锁死：propose 结算面不得再出现「重新提议」类再入诱导。
 *
 * 守卫形态说明：文案是字符串常量，行为级等价物 = 对 propose 分支产出的 message 全量断言
 * （canvas-write.test.ts 逐分支锁定本文件产出的 JSON）；此处对源做 tripwire 扫描是第二道
 * 保险——两道叠加，删任何一道另一道仍红。
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./canvas-write.ts", import.meta.url)), "utf8");

test("propose 结算文案不得诱导重新提议（RCA v2 R3）", () => {
	assert.ok(
		!src.includes("请重新 propose_generation"),
		"stale_status 等结算分支不得再出现「请重新 propose_generation」（死循环诱导）",
	);
});

test("timeout / stale_status 结算必须明示「不要再次 propose_generation」（终局语义）", () => {
	const occurrences = src.split("不要再次 propose_generation").length - 1;
	assert.ok(occurrences >= 2, `timeout 与 stale_status 两分支都应是终局引导，实测 ${occurrences} 处`);
});
