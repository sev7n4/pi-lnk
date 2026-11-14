import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTodoTools } from "./todo.js";
import { readRecord } from "../hook-contract.js";
import { Metrics } from "../metrics.js";

/** C-2a/C-2b 接线守卫（仿 html-craft.wiring / SOP 刀）：防「机制装了但生产没注入」
 *  —— tool_search 激活率 0 与 spawn_subagent 零调用都是这一形态的前科。 */
describe("C-2a/C-2b acceptance wiring", () => {
	it("todo_write schema 暴露 acceptance，kind 枚举恰为两类已实现 oracle", () => {
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
		const consts = Array.isArray(kind.value.anyOf)
			? (kind.value.anyOf as unknown[]).map((v) => (v as { const?: unknown }).const)
			: [kind.value.const ?? (kind.value as { enum?: unknown[] }).enum?.[0]];
		// 枚举封死：只注册已实现校验的两类（noOverlap / user_confirm 代码零实现 ⇒ 不得出现）
		assert.deepEqual(consts, ["generation", "canvas_state"]);
		const required = acceptance.value.required;
		assert.ok(Array.isArray(required) && required.includes("kind"), "kind 必须是必填（缺失即字段非法）");
		// C-2b：canvasState 载荷只暴露已实现的两个谓词
		const cs = readRecord(accProps.value.canvasState, "acceptance.properties.canvasState");
		assert.ok(cs.ok, "schema 未暴露 canvasState");
		if (cs.ok) {
			const csProps = readRecord(cs.value.properties, "canvasState.properties");
			assert.ok(csProps.ok);
			if (csProps.ok) {
				assert.deepEqual(Object.keys(csProps.value).sort(), ["nodeCount", "nodeTypeCounts"]);
			}
		}
	});

	it("config.ts 生产注入两类 oracle + 指标回调；纯文本模式仍零参", () => {
		const src = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
		assert.match(src, /createNestGenerationOracle\(client\)/, "生产工具表未注入生成 oracle");
		assert.match(src, /createNestCanvasOracle\(client\)/, "生产工具表未注入画布 oracle");
		assert.match(src, /metrics\.observeAcceptance\(outcome\)/, "outcome 指标回调未接线");
		assert.match(src, /metrics\.observeAcceptanceKind\(kind\)/, "kind 指标回调未接线");
		assert.match(src, /buildTodoTools\(\)/, "纯文本模式零参调用消失（会破坏逐字节旧行为）");
	});

	it("⭐ 判据单点：C-1 eval 与生产 acceptance 引用同一个 judgeCanvasCounts", () => {
		const golden = readFileSync(new URL("../eval/golden-cases.ts", import.meta.url), "utf8");
		const acceptance = readFileSync(new URL("./acceptance.ts", import.meta.url), "utf8");
		assert.match(golden, /import \{[^}]*judgeCanvasCounts[^}]*\} from "\.\.\/canvas-judge\.js"/);
		assert.match(golden, /return judgeCanvasCounts\(canvas, expect\)/, "eval 侧判据不得另起实现");
		assert.match(acceptance, /judgeCanvasCounts\(canvas, expect\)/, "生产侧必须复用同一判据函数");
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

	it("Metrics 渲染 pi_runtime_acceptance_kind_total（canvas_state 写入率可观测）", () => {
		const m = new Metrics();
		assert.doesNotMatch(m.render(0, "test"), /pi_runtime_acceptance_kind_total\{/);
		m.observeAcceptanceKind("canvas_state");
		m.observeAcceptanceKind("canvas_state");
		m.observeAcceptanceKind("generation");
		const out = m.render(0, "test");
		assert.match(out, /pi_runtime_acceptance_kind_total\{kind="canvas_state"\} 2/);
		assert.match(out, /pi_runtime_acceptance_kind_total\{kind="generation"\} 1/);
	});
});
