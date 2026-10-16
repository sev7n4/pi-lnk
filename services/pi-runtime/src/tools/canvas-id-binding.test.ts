/** canvas-id-binding 单测（spec 2026-10-16 P1-C/P1-D）：纯逻辑直调，stub harness 见 Task 3。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	closeBindingWindow,
	decideBinding,
	recordUpsertedNode,
	resetIdBindingForTest,
} from "./canvas-id-binding.js";

function upsertContent(nodeId: string) {
	return [{ type: "text", text: JSON.stringify({ ok: true, data: { nodeId, actions: [] } }) }];
}

describe("canvas-id-binding: 同批窗口捕获与裁决（spec P1b）", () => {
	it("窗口未开（无 pending upsert）→ 放行旧节点引用（合法用户点名，spec P1-D）", () => {
		resetIdBindingForTest();
		assert.deepEqual(decideBinding("propose_generation", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("窗口内单 upsert + node_id 不一致 → rewrite 为记录 id（spec P1-C，零重试主路径）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		const original = { node_id: "image-old", guide_scene_id: "s1" };
		const d = decideBinding("propose_generation", original, "r1");
		assert.deepEqual(d, { kind: "rewrite", nodeId: "image-new" });
		// 不突变调用方 args（重写由 register 层展开新对象）
		assert.equal(original.node_id, "image-old");
	});

	it("node_id 已等于记录 id → passthrough（含 update 路径 upsert 返回 existing.id）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		assert.deepEqual(decideBinding("set_node_generation_params", { node_id: "image-new" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("同批多 upsert（无法消歧）→ fail-closed block 且 reason 列出全部候选 id（Review Focus #2）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-a"));
		recordUpsertedNode("r1", upsertContent("image-b"));
		const d = decideBinding("propose_generation", { node_id: "image-a" }, "r1");
		assert.equal(d.kind, "block");
		assert.ok(d.kind === "block" && d.reason.includes("image-a") && d.reason.includes("image-b"));
	});

	it("非 set/propose 工具（如同批 set_node_text）→ 永不介入（spec P1b 范围锁定）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		assert.deepEqual(decideBinding("set_node_text", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("畸形 content（非 JSON / 缺 data.nodeId / 非 text 块）→ fail-soft 不记录、不抛（Review Focus #3）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", [{ type: "text", text: "not json" }]);
		recordUpsertedNode("r1", [{ type: "text", text: JSON.stringify({ ok: true }) }]);
		recordUpsertedNode("r1", "string-content");
		assert.deepEqual(decideBinding("propose_generation", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("before_request 关窗：同 run 后续消息合法提名旧节点 → 不误重写（Review Focus #1）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		closeBindingWindow("r1");
		assert.deepEqual(decideBinding("propose_generation", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("窗口按 runId 隔离：r2 的窗口不影响 r1，反之亦然", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-r1"));
		assert.deepEqual(decideBinding("propose_generation", { node_id: "x" }, "r2"), { kind: "passthrough" });
		assert.deepEqual(decideBinding("propose_generation", { node_id: "x" }, "r1").kind, "rewrite");
	});
});
