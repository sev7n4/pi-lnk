import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTodoTools } from "./todo.js";
import { readRecord } from "../hook-contract.js";
import { Metrics } from "../metrics.js";

/** C-2a 接线守卫（仿 html-craft.wiring / SOP 刀）：防「机制装了但生产没注入」
 *  —— tool_search 激活率 0 与 spawn_subagent 零调用都是这一形态的前科。 */
describe("C-2a acceptance wiring", () => {
	it("todo_write schema 暴露 acceptance 且 kind 枚举封死", () => {
		const [t] = buildTodoTools();
		const root = readRecord(t.parameters, "todo_write.parameters");
		assert.ok(root.ok);
		if (!root.ok) return;
		const todos = readRecord(root.value.properties, "todo_write.parameters.properties");
		assert.ok(todos.ok);
		if (!todos.ok) return;
		const todosProp = readRecord(todos.value.todos, "properties.todos");
		assert.ok(todosProp.ok);
		if (!todosProp.ok) return;
		const items = readRecord(todosProp.value.items, "properties.todos.items");
		assert.ok(items.ok);
		if (!items.ok) return;
		const props = readRecord(items.value.properties, "todos.items.properties");
		assert.ok(props.ok);
		if (!props.ok) return;
		const acceptance = readRecord(props.value.acceptance, "todos.items.properties.acceptance");
		assert.ok(acceptance.ok, "schema 未暴露 acceptance（模型无从声明）");
		if (!acceptance.ok) return;
		const accProps = readRecord(acceptance.value.properties, "acceptance.properties");
		assert.ok(accProps.ok);
		if (!accProps.ok) return;
		const kind = readRecord(accProps.value.kind, "acceptance.properties.kind");
		assert.ok(kind.ok);
		if (!kind.ok) return;
		assert.deepEqual(kind.value.const ?? (kind.value as { enum?: unknown[] }).enum?.[0], "generation");
		const required = acceptance.value.required;
		assert.ok(Array.isArray(required) && required.includes("kind"), "kind 必须是必填（缺失即字段非法）");
	});

	it("config.ts 生产注入 oracle + 指标回调；纯文本模式仍零参", () => {
		const src = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
		assert.match(src, /createNestGenerationOracle\(client\)/, "生产工具表未注入生成 oracle");
		assert.match(src, /metrics\.observeAcceptance\(outcome\)/, "指标回调未接线");
		assert.match(src, /buildTodoTools\(\)/, "纯文本模式零参调用消失（会破坏逐字节旧行为）");
	});

	it("Metrics 渲染 pi_runtime_acceptance_total（四类 outcome 可查）", () => {
		const m = new Metrics();
		const before = m.render(0, "test");
		assert.doesNotMatch(before, /pi_runtime_acceptance_total\{/, "零流量时不得渲染数据行");
		m.observeAcceptance("declared");
		m.observeAcceptance("declared");
		m.observeAcceptance("pass");
		m.observeAcceptance("fail_closed");
		m.observeAcceptance("fail_open");
		const out = m.render(0, "test");
		assert.match(out, /pi_runtime_acceptance_total\{outcome="declared"\} 2/);
		assert.match(out, /pi_runtime_acceptance_total\{outcome="pass"\} 1/);
		assert.match(out, /pi_runtime_acceptance_total\{outcome="fail_closed"\} 1/);
		assert.match(out, /pi_runtime_acceptance_total\{outcome="fail_open"\} 1/);
	});
});
