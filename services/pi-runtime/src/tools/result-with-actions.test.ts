/**
 * 写工具统一返回形态的契约测试。
 *
 * 这类 helper 的存在理由是 PR #65（delete_nodes）踩过的坑：
 * `actions` 若不走 `details.actions`，Nest 的 extractCanvasActions 取不到，
 * canvas_action SSE 不发 → 「服务端已改、画布不动，要等回合末全量回拉」。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractActions, resultWithActions } from "./result-with-actions.js";

describe("result-with-actions", () => {
	it("extractActions：只收对象元素，非数组/脏数据回空数组", () => {
		assert.deepEqual(extractActions({ actions: [{ type: "remove_edge", payload: { id: "e1" } }] }), [
			{ type: "remove_edge", payload: { id: "e1" } },
		]);
		assert.deepEqual(extractActions({ actions: "oops" }), []);
		assert.deepEqual(extractActions({}), []);
		assert.deepEqual(extractActions(null), []);
		assert.deepEqual(extractActions({ actions: [null, 1, { type: "x" }] }), [{ type: "x" }]);
	});

	it("resultWithActions：content 保持 {ok,data} 文本，actions 进 details", () => {
		const out = resultWithActions({ actions: [{ type: "add_node", payload: { id: "n1" } }], nodeId: "n1" });
		assert.ok(out.content[0].text.includes("nodeId"), "模型仍能看到业务载荷");
		assert.deepEqual(out.details, { actions: [{ type: "add_node", payload: { id: "n1" } }] });
	});

	it("无 actions 时 details.actions 为空数组（不是 undefined，避免 extractCanvasActions 早退语义歧义）", () => {
		assert.deepEqual(resultWithActions({ ok: true }).details, { actions: [] });
	});
});
