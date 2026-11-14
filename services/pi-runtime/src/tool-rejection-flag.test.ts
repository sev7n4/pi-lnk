/**
 * isError 语义补正接线测试（spec 2026-11-14-iserror-rejection-flag-design.md）。
 *
 * 三层覆盖：纯判定 / fake hooks 接线（含 vendor 链式 replace 模拟）/ **真实 todo_write 行为级**
 * （不能只测纯函数——记忆纪律：守卫须行为级）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	isToolRejectionFlagEnabled,
	registerToolRejectionFlag,
	shouldFlagRejection,
	type RejectionFlagHooksRegistrar,
	type RejectionFlagToolEvent,
} from "./tool-rejection-flag.js";
import { buildTodoTools, resetTodoStoreForTest } from "./tools/todo.js";
import type { LnkpiToolContext } from "./tools/types.js";

type Handler = (event: RejectionFlagToolEvent) => unknown;
class FakeHooks implements RejectionFlagHooksRegistrar {
	readonly names: string[] = [];
	readonly handlers: Handler[] = [];
	on(name: "after_tool", handler: Handler): () => void {
		this.names.push(name);
		this.handlers.push(handler);
		return () => {};
	}
}

const ctx: LnkpiToolContext = { sessionId: "sess-FLAG", userId: "user-FLAG" };
type TodoTool = ReturnType<typeof buildTodoTools>[number];
type TodoCallItem = { content: string; status: "pending" | "in_progress" | "completed" };
const invocation = {
	invocationId: "inv-1", operationId: "op-1", turnId: "turn-1",
	getMemo: async () => undefined, setMemo: async () => {},
};
const context = { abortSignal: new AbortController().signal, value: () => undefined };
function run(t: TodoTool, params: { todos: TodoCallItem[] }) {
	return t.execute("call-t", params, () => {}, ctx, invocation, context);
}

describe("shouldFlagRejection（纯判定）", () => {
	test("details.todo.rejected === true ⇒ true", () => {
		assert.equal(shouldFlagRejection({ todo: { snapshot: [], diff: { updates: [] }, rejected: true } }), true);
	});

	test("缺标记 / rejected:false / 形态异常 ⇒ false（fail-soft）", () => {
		assert.equal(shouldFlagRejection({ todo: { snapshot: [], diff: { updates: [] } } }), false);
		assert.equal(shouldFlagRejection({ todo: { rejected: false } }), false);
		assert.equal(shouldFlagRejection({ todo: { rejected: "true" } }), false);
		assert.equal(shouldFlagRejection({ todo: null }), false);
		assert.equal(shouldFlagRejection(undefined), false);
		assert.equal(shouldFlagRejection("oops"), false);
	});
});

describe("registerToolRejectionFlag（接线）", () => {
	test("缺省开启 ⇒ 注册一个 after_tool listener；命中标记返回 {isError:true}", () => {
		const prev = process.env.PI_RUNTIME_REJECTION_FLAG;
		delete process.env.PI_RUNTIME_REJECTION_FLAG;
		try {
			assert.equal(isToolRejectionFlagEnabled(), true);
			const hooks = new FakeHooks();
			registerToolRejectionFlag(hooks);
			assert.deepEqual(hooks.names, ["after_tool"]);
			const patch = hooks.handlers[0]({
				toolName: "todo_write",
				details: { todo: { snapshot: [], diff: { updates: [] }, rejected: true } },
			});
			assert.deepEqual(patch, { isError: true });
		} finally {
			if (prev === undefined) delete process.env.PI_RUNTIME_REJECTION_FLAG;
			else process.env.PI_RUNTIME_REJECTION_FLAG = prev;
		}
	});

	test("非 todo_write / 正常 todo_write 回执 ⇒ undefined（不误伤）", () => {
		const hooks = new FakeHooks();
		registerToolRejectionFlag(hooks);
		assert.equal(hooks.handlers[0]({ toolName: "get_canvas_summary", details: { todo: { rejected: true } } }), undefined);
		assert.equal(hooks.handlers[0]({ toolName: "todo_write", details: { todo: { snapshot: [], diff: { updates: [] } } } }), undefined);
		assert.equal(hooks.handlers[0]({ toolName: "todo_write", details: undefined }), undefined);
	});

	test("kill switch off ⇒ 不注册（逐字节回滚）", () => {
		const prev = process.env.PI_RUNTIME_REJECTION_FLAG;
		process.env.PI_RUNTIME_REJECTION_FLAG = "off";
		try {
			assert.equal(isToolRejectionFlagEnabled(), false);
			const hooks = new FakeHooks();
			registerToolRejectionFlag(hooks);
			assert.equal(hooks.names.length, 0);
		} finally {
			if (prev === undefined) delete process.env.PI_RUNTIME_REJECTION_FLAG;
			else process.env.PI_RUNTIME_REJECTION_FLAG = prev;
		}
	});

	test("hooks 缺席 ⇒ 不抛（fake harness fail-soft）", () => {
		assert.doesNotThrow(() => registerToolRejectionFlag(undefined));
	});

	test("⭐ vendor 链式 replace 模拟：后续 listener 看到 isError=true", () => {
		const hooks = new FakeHooks();
		registerToolRejectionFlag(hooks);
		const seen: boolean[] = [];
		hooks.on("after_tool", (event) => {
			seen.push((event as RejectionFlagToolEvent & { isError?: boolean }).isError === true);
			return undefined;
		});
		// 复刻 hooks.ts:298-324 的 current 传递语义
		const base = {
			toolName: "todo_write",
			details: { todo: { snapshot: [], diff: { updates: [] }, rejected: true } },
			isError: false,
		};
		const patch = hooks.handlers[0](base) as { isError?: boolean } | undefined;
		const current = { ...base, isError: patch?.isError ?? base.isError };
		hooks.handlers[1](current);
		assert.deepEqual(seen, [true]);
	});
});

describe("行为级：真实 todo_write 硬拒 ⇄ 补正标志", () => {
	test("幻觉 id 硬拒的 details 触发 patch，且零副作用不变量保持", async () => {
		resetTodoStoreForTest();
		const [t] = buildTodoTools();
		const res = await run(t, { todos: [{ content: "起稿", status: "pending" }] });
		// 先正常写入，再用不存在的 id 触发硬拒
		const rejected = await t.execute(
			"call-2",
			{ todos: [{ content: "起稿", status: "pending", id: "plan-999" }] },
			() => {}, ctx, invocation, context,
		);
		assert.equal((rejected as { isError?: boolean }).isError, true);
		assert.equal(shouldFlagRejection(rejected.details), true, "硬拒 details 必须带 rejected 标记");
		const details = rejected.details as { todo: { snapshot: unknown[]; diff: { updates: unknown[] }; rejected?: boolean } };
		assert.deepEqual(details.todo.diff.updates, [], "硬拒仍零副作用");
		assert.equal(details.todo.rejected, true);
		// 正常回执不带标记（不误伤）
		assert.equal(shouldFlagRejection(res.details), false);
	});

	test("验收证据不足硬拒同样带标记（A-2' / C-2a / C-2b 共用 rejectionResult）", async () => {
		resetTodoStoreForTest();
		const [t] = buildTodoTools({
			canvasOracle: {
				async inspect() { return { ok: true, canvas: { nodeCount: 0, typeCounts: {} } }; },
			},
		});
		const res = await t.execute(
			"call-3",
			{
				todos: [{
					content: "摆节点", status: "completed",
					acceptance: { kind: "canvas_state", canvasState: { nodeCount: { min: 1 } } },
				}],
			},
			() => {}, ctx, invocation, context,
		);
		assert.equal((res as { isError?: boolean }).isError, true);
		assert.equal(shouldFlagRejection(res.details), true);
	});
});

describe("wiring 守卫（源码级：防「装了没接」）", () => {
	test("index.ts：补正 listener 注册在所有 after_tool 之前", () => {
		const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		const flag = src.indexOf("registerToolRejectionFlag(harness.hooks)");
		const binding = src.indexOf("registerCanvasIdBindingHooks(harness)");
		assert.ok(flag >= 0, "index.ts 未注册补正 listener");
		assert.ok(binding >= 0);
		assert.ok(flag < binding, "注册序错误：HookMap 链式 replace 要求补正 listener 最前");
	});

	test("todo.ts：rejectionResult 单点写入 rejected:true（零副作用细节不丢）", () => {
		const src = readFileSync(new URL("./tools/todo.ts", import.meta.url), "utf8");
		assert.match(src, /diff: \{ updates: \[\] \}, rejected: true/);
	});
});
