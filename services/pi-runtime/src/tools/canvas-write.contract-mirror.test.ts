/**
 * RB-D7 契约镜像（runtime 消毒侧）：与 packages/shared/fixtures/sidebar-attachments-contract.json
 * 共享 SSOT。镜像不变量（Ruling 2026-10-13 PR-B）：
 *   Zod pass            ⇒ prepareArguments 透传
 *   reject(limit)       ⇒ 透传（Nest SSOT 裁量，M-2）
 *   reject(non-array)   ⇒ 透传（消毒只管数组形态）
 *   reject(shape)       ⇒ 整参数删除（execute 回落 tc.attachments，RB-D2）
 * 任何一侧改 fixture 必双侧同步——漂移即本测试红。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvasWriteTools } from "./canvas-write.js";

// makeClient/findTool 与 canvas-write.test.ts 顶部同构（该文件未导出 helper；漂移时以彼为准）。
function makeClient() {
	const client = {
		post: async () => ({}),
	};
	return { client: client as never };
}

function findTool(tools: ReturnType<typeof createCanvasWriteTools>, name: string) {
	const tool = tools.find((t) => t.name === name);
	assert.ok(tool, `tool ${name} not registered`);
	return tool;
}

interface FixtureEntry {
	name: string;
	attachments: unknown;
	expectZod: "pass" | "reject";
	rejectReason?: "shape" | "limit" | "non-array";
}

const fixture: FixtureEntry[] = JSON.parse(
	readFileSync(
		fileURLToPath(new URL("../../../../packages/shared/fixtures/sidebar-attachments-contract.json", import.meta.url)),
		"utf8",
	),
) as FixtureEntry[];

/** Ruling 表：Zod 结论 ⇒ 消毒行为。 */
function expectSanitize(e: FixtureEntry): "passthrough" | "delete" {
	if (e.expectZod === "pass") return "passthrough";
	if (e.rejectReason === "shape") return "delete"; // 仅数组内形状错
	return "passthrough"; // limit / non-array 归 Nest
}

describe("canvas-write: 侧栏附件契约镜像（RB-D7，fixture SSOT）", () => {
	const { client } = makeClient();
	const tool = findTool(createCanvasWriteTools(client), "apply_sidebar_attachments");

	for (const e of fixture) {
		it(`[${e.name}] sanitize ⇒ ${expectSanitize(e)}`, () => {
			const args = { node_ids: ["n1"], mode: "localRefs", attachments: e.attachments };
			const out = tool.prepareArguments?.(args) as Record<string, unknown> | undefined;
			assert.ok(out, "prepareArguments 必须有返回值");
			if (expectSanitize(e) === "passthrough") {
				assert.deepEqual(out.attachments, e.attachments);
			} else {
				assert.equal("attachments" in out, false, "伪造形态必须整参数删除（含键删除，非 undefined）");
			}
			// 非目标参数永不消毒：node_ids/mode 原样保留
			assert.deepEqual(out.node_ids, ["n1"]);
			assert.equal(out.mode, "localRefs");
		});
	}
});
